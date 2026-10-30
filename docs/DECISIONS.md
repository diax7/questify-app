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

## ADR-203 — Passport quests
**Status:** Proposed (Claude, 2026-10-24; T-304b). Q-167.
**Decision:** a passport is a quest type with 1 to 30 steps in their own table (`passport_step`), each step its own
signed code (format byte 0x04, its own derived key, versioned for reprints, bound to the step it is posted for). The
database pays the quest's points once, through `pay_completion` with the completion key `pass:{quest id}`, when the
distinct stamps reach `needed` and the quest has no completion, under the enrollment lock; steps pay nothing on their
own. `pass:` is reserved in every player key check. A passport is finished once (`repeat_cap` 1); a stamp after it is
finished refuses. Once anyone has stamped, `needed` may rise but never fall and a stamped step cannot be deleted; the
database holds these rules in triggers. The device id lives on the stamp row, not on the paying completion. Steps are
stamped by printed QR only (no station or My QR path yet).
**Why:** FR-224; one payer and one lock keep "paid once" safe under races, as T-304's bonus; a step code that cannot
open as any other code keeps T-104's proof model.

## ADR-204 — Category refresh and hidden categories
**Status:** Accepted (Dhia, 2026-10-24; T-304c). Q-168.
**Decision:** a category may refresh daily or weekly. The repeat cap, "done", the in-order and unlock gates and the
completion bonus count inside the current period: the event's day (ADR-083's day-start hour), or 7-day blocks counted
from the event's first day. The occurrence number stays lifetime (only the cap counts the period). A bonus is not
paid while a row of the current or a later period exists, so switching a category from daily to none never pays it
again. Nothing paid is touched at a reset. Only scan, code and challenge quests may sit in a
refreshing category (the database refuses the mix). A hidden category opens per player by a signed secret code (format
0x05, its own key, versioned for reprints) that pays nothing and takes no Idempotency-Key (a second scan writes
nothing); until then it acts as outside the player's audience (play refused `not_for_you`, an unlock gate on it counts
as met), and the public event page never lists it. An owner's or editor's manual award passes the reveal (the
audience still applies) and reveals the category to that player; an operator scan does not.
**Why:** FR-236, FR-1619, FR-237; one period helper used by every payer keeps "how many this period" in one place
under the enrollment lock; played-once types have no meaning in a refresh.

## ADR-205 — Items as quest or category rewards: their own stock, a price-0 desk item, points only when out
**Status:** Accepted (Dhia, 2026-10-24; T-304d). Q-169.
**Decision:** an item given by a quest or a category is a `quest_item` row (its own table and stock, shared by every
quest and category that names it, never a shop `reward`). Earning it makes a price-0 `redemption` (a third source after
shop rewards and rank prizes) collected through the desk's handover, with `default_claim_until`'s deadline; the player
cannot cancel it, an operator's cancel or the timeout returns the unit with no ledger entry. A quest gives its item on
the player's first completion only; a category gives its item with its bonus, once per period (T-304c), with or
without bonus points. With no stock left, or the desk's hours over, the player gets the points only, is told so, and a
miss is recorded that the organizer sees with a warning; nothing is given later when stock is raised. Removing the
quest or bonus award cancels its pending item; a handed-over item stays. The removed completion still counts
(ADR-152), so a later scan of that quest (occurrence 2) gives no item.
**Why:** FR-522 and FR-1617; ADR-162's separate table fails closed (an item cannot leak into the shop for free) and
reuses the whole handover path; the first-completion rule stops a repeatable quest draining the stock.
**Build notes (2026-10-24):** the claim deadline is `default_claim_until`, else the desk's last window while it is still
ahead (`default_claim_until` alone answers NULL when the desk closes within a day, which would have missed items while
the desk was still open); `quest.item_id` and `category.item_id` are NO ACTION, as `category.unlock_after`, so a draft
event's delete cascades in one statement; the API reuses `desk_needed` and `stock_below_reserved` (the shop's codes)
rather than new ones. After the CTO code review (M1): a pending item's answer carries its deadline and the event's zone, and the app says
"collect it at the prize desk by {time}", so a scan just before the desk closes is not a silent minutes-long
reservation; recording `claim_closed` under a threshold was rejected (it would refuse an item the desk can still hand
over).

## ADR-206 — Location check-in: a placed quest with its QR, distances kept, never coordinates
**Status:** Proposed (Claude, 2026-10-24; T-303b). Q-170.
**Decision:** a `location` quest has a required place (pin and radius, 20 to 2000 m) and always its own quest QR at
the spot (a database check, FR-216). A check-in passes when the phone's fix, no older than 2 minutes and accurate to
500 m or better, lies within the radius plus its accuracy, the allowance capped at the radius; outside, the player is
told the rounded distance. A mocked fix inside the area pays (flags never block play) and raises a flag. **A
check-in proves only that the phone claimed to be there**: latitude, longitude, age, accuracy and the mocked mark are
all reported by the client and can be forged; the speed flag on quest pins is the stronger guard, and for prizes that
matter the organizer should use the QR at the spot (the quest builder says so). No coordinates are stored: the
database turns the position into distances rounded to 10 m and keeps those, the accuracy and the mocked mark in
`completion_position`, a table no API role can read (only its definers), erased with the account. The phone sends a
position only with a check-in, a QR scan or a typed code, in the request body; a bad or stale position on a QR scan
or typed code is dropped and never blocks it. Postgres must not log bound parameters (checked by a test and on
CranL). Amended after the CTO plan review (82/100).
**Why:** FR-215, FR-216, ADR-015, ADR-072 and hard rule 3: the flag page needs "how far, how sure", not a point on a
map, so storing less is the safer default; the capped allowance stops a coarse fix passing a far player.

## ADR-207 — Location flags: far from the venue and impossible speed
**Status:** Proposed (Claude, 2026-10-24; T-303b). Q-171.
**Decision:** `raise_completion_flags` raises two new kinds. `far_from_venue`: the completion's fix, less its
accuracy, lies beyond the event's venue radius (default 1 km) plus 1 km, or the phone marked the fix as mocked.
`impossible_speed`: two consecutive counted completions at quests with places are more than 300 m apart edge to edge
and the pace between them is above 15 m/s (54 km/h), by server receipt time; it uses the quests' pins, so it works
with location refused. Far from the venue is raised when the position row is written (`raise_position_flags`). One
open case per account and kind; never in a virtual event (FR-1744), never from a manual or system-paid completion; no
reading, no far flag. The numbers live in their own `location_tuning()` until T-703 (built: 0031's `flag_tuning` is left as it is, with its callers and grants, coordinator 2026-10-24).
**Why:** FR-331, FR-332, ADR-153; the T-209 trigger covers every completion path, and evidence keeps the
`{completions}` shape so the Flags page reads it through `flag_detail`.

## ADR-208 — When the app asks for location, and the platform switch
**Status:** Proposed (Claude, 2026-10-24; T-303b). Q-172.
**Decision:** never at launch. The app shows its own explanation sheet with one button, "Continue", that always
opens the system prompt (no "Not now", no close, no "Allow" wording: Apple rejects those under 5.1.1(iv)). It is shown
when the player taps "Check in" on a location quest, or once per install right after joining an in-person event
(physical or workplace) that has a venue pin. After a denial the quest sheet offers the QR and the settings link.
Location is read only with a request that
uses it (a fresh fix for a check-in, the last fix up to 2 minutes old for a scan or typed code), never in the
background. A platform switch `locationQuests` stays off until the store privacy answers are updated (ADR-073) and
CranL's database is confirmed not to log query parameters; while
off the app never asks or reads, the builder refuses the type, and existing location quests complete by QR. **Older builds** (made before `expo-location`, which needs a new EAS build): the API sends a location quest with `verification: ["quest_qr"]`; an older app does not know the type, shows it with its "update the app" line and no action, and its scanner completes it from the printed QR (the scanner reads any quest code). This build also offers the QR on any open quest of a type it does not know that keeps a quest QR (`scanFallback`), and loads the location module on demand, so a build without it reads location as unavailable and offers the QR, never crashes.
**Why:** FR-1744, Apple 5.1.1(iv) and 5.1.5, Google's minimum-scope rule; reading per request rather than continuously
keeps ADR-072's "while open" with less data and battery.

## ADR-209 — Meet-someone proof: a one-minute meet code, not My QR
**Status:** Proposed (Claude, 2026-10-24; T-303c). Q-173. Amends FR-212 and FR-306.
**Decision:** a meet quest is proved by its own code, not My QR. The shown player taps "Show my code"; the API makes a
128-bit random token for that quest, keeps only its SHA-256 hash with the player's enrollment and device, and it lives
one minute. The first meeting that pays uses it up; a new code ends the player's earlier open one. Issuing checks the
shown player's caps first. The code names its quest, so any scanner in the app can read it. Both players are paid
together (the quest's points, its item on a first completion, any category bonus) or neither. FR-212 reads "scans the
other's meet code"; FR-306 no longer lists meet-someone.
**Why:** ADR-137 made My QR fixed; a fixed code posted in a group chat would pay its owner a meeting with everyone who
has it. A one-minute single-use code cannot be reused from a screenshot; two friends relaying it live are bounded by
the pair rule and the daily cap (ADR-210).

**Build notes (T-303c, 2026-10-23):** the screen's brightness is not raised while the code shows: that needs `expo-brightness`, a native module and a new EAS build (Q-173 asks whether to add it). The code's minute is a bar that empties; the app reads its state every 2 seconds (5 after a 429), never past its minute, and draws a fresh code when it ends.

## ADR-210 — Meet-someone rules
**Status:** Proposed (Claude, 2026-10-24; T-303c). Q-174.
**Decision:** one meeting per pair of players per quest, in either direction. A daily cap per player (organizer-set, 1
to 50, default 5) counts the player's own meet completions, on either side, since the start of the event's day (so the
other player's erasure never lowers it). The quest's repeat cap is the most meetings it pays a player. If either player
is at a cap or cannot play the quest (account not active, an operator who may not play, audience, category lock, ban),
neither is paid; the scanner is told only "not for them" when the other player cannot play it. A manual award pays one player
and counts towards the repeat cap. The event switch `meetSomeone` (FR-1009) is on by default; off, meet quests are
hidden and refused. Allowed in every event kind.
**Why:** FR-212, FR-213; all-or-nothing keeps the two ledgers in step; the other player's audience or ban is theirs.
**Build notes (T-303c, 2026-10-23):** (1) the rehearsal wipe deletes the rehearsal accounts' codes, not every code of the event (a live player's code stays); (2) a meet quest's code rows cascade with a deleted quest; (3) the platform's `meetSomeone` switch is checked by the API, the event's by the database (`meet_on`); (4) the switch route is the owner's, like the share switch, not the editors' too; (5) the daily-cap line says the cap as a number ("today's limit (5)") because the messages have no Arabic plural forms yet.

## ADR-211 — Meet-someone locks and collusion signals
**Status:** Proposed (Claude, 2026-10-24; T-303c). Q-175.
**Decision:** a function that runs during play and locks more than one enrollment takes them all in one statement in id
order, before item, redemption and advisory locks, and takes more than one device advisory key only in ascending key
order. The meet payer locks both enrollments, then the pass, then the quest's items, then both device keys, and only
then writes; the meeting row is written after both payments, both completions keyed by the pass, and a duplicate
request is recognised under the locks as a replay. Lockers that run only after play ends (`reveal_results`,
`confirm_results`) are left as they are. The scanner's side of a meeting counts in every flag (shared device, burst, far from the venue with its
optional reading); the shown side carries the device that showed the code for the shared-device check only, not the
burst. The same device on both sides is refused. The shown player's position is never sent and no pair distance is
computed (no coordinates are kept, ADR-206). No new flag kind until real data shows a pattern.
**Why:** two enrollments or two devices per transaction would deadlock against a locker using another order (CTO plan
review 2026-10-24); a popular player shown
many times is not a script; comparing two positions would mean keeping coordinates.
**Build notes (T-303c, 2026-10-23):** the two payments run in player id order, not enrollment id order: Questify XP rows are per player across events, so two meetings of the same two players in two events would otherwise cross (a race test covers it). The rate limiter's lock is `pg_try_advisory_xact_lock` in its own transaction, so it never waits inside a meeting.
A meeting without an `x-device-id` (a header the client sends, never trusted) skips the same-device refusal and, for that side, the shared-device flag; the pair rule and the daily cap still bound what it earns (CTO code review 2026-10-23, accepted). A deadlock or serialization failure answers 503 `busy` with Retry-After (`conventions.ts`).

## ADR-212 — Mini-game rounds and replay
**Status:** Proposed (Claude, 2026-10-24; T-305). Q-176. Specifies ADR-097's checking.
**Decision:** the database issues each round: a 32-bit seed from `gen_random_uuid`, its own clock, the game and level
frozen from the quest, and the level's numbers from its own copy of the level table. Issuing uses an attempt. The phone
sends its inputs and the result its engine found; the API replays the inputs with the same shared engine and never
trusts a reported score. Impossible play (an illegal input, inputs out of order, closer than 100 ms, past the time
limit or over the cap, a reported result the replay does not reproduce, or more play time than the server saw pass)
refuses the round, which counts as played, and raises a `minigame` flag. Legal but unlikely play is paid and flagged.
The refusal's reason is shown to the organizer, never to the player. An honest player is never refused: each game's
engine version is frozen on the round and replayed with that version, an app whose engine is older is told to update
before an attempt is used, and the app's board drops every tap the replay would call impossible. A refusal of the
request (past the window, a player who can no longer play) writes nothing; the verdicts are written and returned.
The app plays every round with the round's `engineVersion` and keeps every `v<n>` engine it may be handed; a server
deploy carrying a new engine version goes out before the app release that uses it (RUNBOOK, Database and deploy).
**Why:** FR-218, FR-1805; a refused honest round would cost an attempt and flag an innocent player (CTO plan review
2026-10-24). The seed reaches the phone, so a modified app can see the layout; the targets sit below
perfect play, the unlikely checks catch the cheap version, and the reward is one quest's points once. A round trip per
move (the quiz's model) would make the games unplayable on a venue network.

## ADR-213 — Mini-game attempts, pass and retry
**Status:** Proposed (Claude, 2026-10-24; T-305). Q-177.
**Decision:** one quest type `game` with a game and a level (easy, medium, hard). Attempts 1 to 10 (default 1), or
unlimited with a cooldown of 1 to 1,440 minutes; an attempt is used when a round is issued, and Play is idempotent (a
retried request returns the same round). The quest pays its points, frozen at issue, once, on the first pass; the item
and the category bonus follow as for every payer. All attempts used without a pass counts the quest done for category
gates and the bonus (as a quiz with no right answers). A result is taken until the time limit plus 10 minutes; the app
keeps the inputs in memory only. The event switch `miniGames` (FR-1009) is on by default; off, game quests are hidden
and no round is issued, but a round already issued may still send its result. Allowed in every event kind. A game
quest's game, level, attempts and cooldown are locked once a round exists (its points stay editable). While the app
holds an unsent result, the quest shows Retry instead of Play.
**Why:** FR-1806, FR-1807, FR-1809, F-309; counting at issue stops quitting a bad layout; no dead end in an in-order
category.

## ADR-214 — T-305 is split in three
**Status:** Proposed (Claude, 2026-10-24; T-305). Q-179.
**Decision:** T-305 builds the round machinery for all four games, and memory match and slide puzzle end to end.
T-305c builds catch and tap rush (real-time, fixed-tick replay) on it. T-305b builds organizer images on cards, puzzles
and falling items (FR-1808) once a Questify bucket exists (Q-149); until then the default art shows. The builder
refuses the two later games as "not available yet".
**Why:** the turn-based and real-time replays are different problems, the app screens double the work, and images
need uploads that are blocked on the bucket (ADR-183).

## ADR-215 — Mini-game levels and how the games are drawn
**Status:** Proposed (Claude, 2026-10-24; T-305). Q-178.
**Decision:** each game's easy, medium and hard numbers (board size, time limit, target) are Questify tuning kept on
the server and sent with every round, so retuning is a deploy, not a store release; the organizer picks only the level.
The board never mirrors in Arabic (the instructions and the bar do). Motion uses React Native's own `Animated`, so the
games add no native module and no new EAS build. Built (T-305): the unlikely count of lucky matches is part of each
memory level's numbers (easy 3, medium and hard 4), because a player who remembers every card but never peeks reached 3
in 1.2% (medium) and 1.7% (hard) of 5,000 seeded rounds; at 4 it is 0.1% and 0.3% (easy stays 3, at 0.9%).
**Why:** configuration over code without giving organizers numbers they cannot judge; a picture puzzle cannot mirror.

## ADR-216 — Real-time mini-game replay
**Status:** Proposed (Claude, 2026-10-24; T-305c plan). Q-181. Extends ADR-212.
**Decision:** catch and tap rush move their world only on a fixed 30 Hz tick, in integers, on a 1,000 × 1,000-unit
board. Inputs keep their time in whole milliseconds; one shared integer function maps a time to its tick. A real-time
engine adds `advance(state, tick)` to the game engine contract, so the replay, the judge and the app's gate are reused
unchanged. The app reads its clock once a frame, records that frame's input before advancing the world, and only
interpolates for drawing, so frame rate and stalls never change a result. Catch records the basket's target only when
it changes, at most once a tick, and the world caps the basket's speed. A real-time round pauses while the app is not
active: the board is covered and the paused time is taken out of the game clock (the server's clock check only refuses
more phone time than it saw, and the result window still bounds the pause). The quest sheet takes a game this build
does not know and shows the update line. CTO plan review 2026-10-24: 84/100, findings folded in.
**Why:** FR-1804, FR-1805; a replay must give the phone's result exactly on Node and release Hermes whatever the
phone's frame rate (`docs/plans/2026-10-24-t-305c-catch-tap-rush.md`).

## ADR-217 — Reaction bounds in the real-time games
**Status:** Proposed (Claude, 2026-10-24; T-305c plan). Q-181. Replaces T-305's sketch of a share of fast hits.
**Decision:** a tap on a target younger than 120 ms, or a second tap inside 100 ms, is dropped by the app and is
impossible in a replay; a tap within 150 ms after a target went is neither hit nor miss. Fast but possible play raises
the unlikely flag and is paid: tap rush hits under 200 ms, and catch items whose first move onto them came inside
their first 133 ms from a target not already there, each counted against a level threshold set so honest play (a fast
tail of reactions included) is flagged in under 1% of seeded rounds.
**Why:** a share-based refusal could refuse an honest fast player; a gate costs an honest player one ignored tap and
keeps "an honest player is never refused" (ADR-212).
**Built (T-305c, 2026-10-24):** a live target in the cell decides first (hit, or dropped by the 120 ms gate); the
150 ms grace applies only to an empty cell. Thresholds set by the calibration tests (5,000 seeds a level): catch's
`unlikelyForesight` 10 / 12 / 16 (easy / medium / hard; the honest model, which drags over 100 to 300 ms and so sweeps
past new items, peaks at 7 / 9 / 13), tap rush's `unlikelyQuick` 8 at every level (honest peak 5). The catch seed
reader flicks onto each item the tick it spawns and returns to the item landing next (one that only moved at spawn
would miss most items and so be counted for few). **Limit (CTO code review):** catch's `foreseen` flag only catches a
naive seed reader. One that waits 4 ticks or more before moving onto an item, or is already in position when it
spawns, is never counted. The flag is advisory only (the round is paid) and is not a defence against a careful bot.
Replay cost: the worst-case catch body (1,351 inputs, hard) is judged in about 17 ms; the bound is 50 ms in the
calibration file and 150 ms in the unit file, which Stryker also runs. The plan said 25 ms; 50 ms leaves room for CI's
2-core runner.

## ADR-218 — Catch and tap rush rules and levels
**Status:** Proposed (Claude, 2026-10-24; T-305c plan). Q-182. Extends ADR-215.
**Decision:** catch runs 45 s and every item can be caught by a perfect player; tap rush runs 30 s on a 3 × 4 grid
and scores hits minus misses. The level numbers in the T-305c plan are starting tuning, sent with each round. The
64 KB result body limit stays one number for every game (a full catch round is under 40 KB).
**Why:** pass targets below perfect play (ADR-212); a miss penalty stops tapping everywhere from passing.

## ADR-219 — T-306 is split in three
**Status:** Proposed (Claude, 2026-10-24; T-306 plan). Q-183.
**Decision:** T-306 builds live polls (FR-239 to FR-242). T-306b builds community quests (FR-243 to FR-246, FR-248 to
FR-250, FR-1620, and FR-247's points, real-world moment and nothing). T-306c builds FR-247's unlock rewards (a quest,
category or shop reward locked until a community step is reached). The poll push and the milestone push move to
T-501; the poll and community scenes on the big screen to T-504.
**Why:** polls are a small change on the finished vote type; the community payer pays many players in one step and
needs its own lock, batch and idempotency rules; unlocks add a gate to every quest and shop reader. Push and the big
screen do not exist yet.

## ADR-220 — A live poll is a vote quest with a live block
**Status:** Proposed (Claude, 2026-10-24; T-306 plan). Q-184.
**Decision:** a vote quest may carry `live: {choices: one | several, results: after_vote | at_close | never, minutes:
1..1440}`. Saved as a draft (hidden, no window); Send sets `visible`, `opens_at = now()` and `closes_at = now() +
minutes`, Close moves `closes_at` to now; the API role cannot set those columns on a live poll (guard trigger). Several
choices are one row per option in `quest_vote`, one completion and one payment. Points are the quest's (0 = none);
XP follows the quest rule unchanged. Players read counts only when the policy allows; the team always. A poll sent
in rehearsal goes back to draft at go-live.
**CTO plan review (2026-10-24):** live polls are left out of every category rule (done, cleared, the in-order
check both ways), so a short poll never blocks a bonus or the next quest; the guard checks the new row's values and
refuses adding or removing `live` on a visible or sent quest and changing its choices or minutes once sent; a poll
never stays open past the event end; with several choices, shares are out of voters.
**Why:** reusing the quest gives points, the ledger, audiences, rehearsal, erasure and removal for free, and the
quest's own window means no player reader changes.
**Build notes (T-306, 2026-10-24, migration 0052):** CTO re-review 1: a category of only live polls counts as empty
for the gates (cleared, so the category after it opens at once) and is never done (no bonus). CTO re-review 2: a
category holding a live poll cannot switch to refreshing (0046's `category_refresh_type`; a vote is a played-once
type). The guard (`quest_live_poll_guard`, API seat) and `quest_lock_played` (every seat) answer `PL409 {field}`:
`window`, `live`, `choices`, `minutes`; the builder answers 409 `poll_locked {field}` and never sends a live poll's
window. Send and Close write their times to the millisecond, so the builder's read and write back of a sent poll
leaves the window exactly as it was. A send in a live event runs the go-live wipe first, so every send the wipe sees
is a rehearsal send (the wipe resets them on either reason). Before go-live a send needs a running rehearsal
(`event_not_live` otherwise). `GET /v1/quests/{id}/vote` answers `mine` as a list.

## ADR-221 — Live updates are polled for now
**Status:** Proposed (Claude, 2026-10-24; T-306 plan). Q-185.
**Decision:** the app reads `GET /v1/events/{id}/live` (open live polls the player has not voted in, recently closed
polls with results, and T-306b's community progress) every `livePollSeconds` (tuning, 10) while an event screen is
open and the app is active, with an ETag over the body without `serverNow` (sent in a header too) and 304; an
event with nothing live answers without the per-player query, and its open-poll list is cached 3 s. The server-sent stream described in API.md is not built; it is the
growth step if the big screen (T-504) or a load test needs updates faster than polling gives.
**Why:** polls and a progress bar tolerate a 10 s delay; one small indexed call is cheaper to build and run than a
stream with its fan-out, reconnects and proxy limits.
**Build notes (T-306, 2026-10-24):** anyone who is not an active member of the event gets the same empty answer
(200), so the read names no event; the 3 s cache holds `event_has_open_poll` per event (open now or closed in the
last 15 minutes), and when it is false the API answers empty without a query. The 30-a-minute limit is counted in
each API instance's memory (a fixed minute window), not in `auth_throttle`: a database row per poll at 500 calls a
second would cost more than the read it guards; with several instances a player may get 30 per instance. The API has
no CORS (the dashboard reaches it through its own proxy and does not read `Server-Now`), so no
`Access-Control-Expose-Headers` is needed (CTO re-review 4).

## ADR-222 — Community quest counting
**Status:** Proposed (Claude, 2026-10-24; T-306 plan, built in T-306b). Q-186.
**Decision:** nothing in the scan transaction touches a community goal. A community tick (every 5 s, `FOR UPDATE SKIP
LOCKED` per goal) keeps a settled tally: it adds the slice older than 30 s to a settled value and shows settled plus
the open tail; it settles only up to the oldest open transaction's start (and the API's connections end an idle
transaction after 10 s), and closes a goal only once the settled point passed its end. Points count `quest`, `bonus` and their removals inside the window; completions count the chosen quest
or category minus removals; players count contributors, kept as rows, who are also the default reward list. When a
step is reached its payee list is frozen (contributors, or every active player then). A goal closes at its end (or
the event's) plus 15 s: reached or missed; a missed goal pays nothing. One running goal per event; no rehearsal run.
**Why:** a shared counter row would serialise every scan in an event at 20,000 completions a minute; a 30 s lag covers
open transactions (5 s statement timeout), so a settled slice is read once and never again.

## ADR-223 — The community payer
**Status:** Proposed (Claude, 2026-10-24; T-306 plan, built in T-306b). Q-187.
**Decision:** a community points reward is ledger kind `community`, actor `system`, balance only while the shop is
open, no XP (XP follows `quest` entries only). The tick pays due payout rows in batches of 500: payout rows taken in
enrollment order with SKIP LOCKED, then the batch's enrollments locked in one statement in id order before any other
lock, one entry each, a partial unique index on (step, enrollment) so the database refuses a second payment, one
ranking repair mark per batch. A failed batch rolls back and is retried on the next tick; a player request that
waits past the lock timeout gets `503 busy` and retries with its key. `confirm_results` waits (`409
community_paying`) until every goal of the event is closed and paid; the owner's "Settle and pay now" does that
inline, due rows older than 2 minutes raise an alert, and switching community quests off closes running goals.
The five community tables are closed (RLS, no grant, PUBLIC revoked) with outsider tests, and a two-connection test
crosses the payer with a meet payment.
**Why:** one transaction for thousands of players would hold their rows for seconds and block their scans; batches
in id order keep the ADR-211 lock order and bound any wait to one batch.

**Build notes (T-306b, CTO code review):** one settle reads at most 10 minutes of ledger past its last settle point,
so a backlog after an outage catches up tick by tick inside the statement limit; the owner's settle loops until final.
**Build notes (T-306b plan, 2026-10-24):** the settle point is bounded by the open transactions of the roles that can
write the ledger only (ADR-224); contributors come from every row read, tail included, and a reached `contributors`
step is topped up until the settled point passes the reach (ADR-225); a removal counts only when it reverses a
counted entry; reaching the goal step finishes the goal; a goal closes once the settled point passes its end (at
least 30 s after; the separate 15 s is dropped).

## ADR-224 — The settle point reads the ledger writers' sessions
**Status:** Proposed (Claude, 2026-10-24; T-306b plan). Q-188.
**Decision:** `community_settle_point()` reads `pg_stat_activity` for client backends of the current database owned by
`questify_app` or the owner (its own backend left out) and returns the oldest `xact_start`. The owner must see those
sessions: migration 0053 grants nothing (CranL's `admin` and CI's owner are superusers) and asserts the owner is a
superuser or `pg_has_role(owner, 'questify_app', 'USAGE')`, failing loudly otherwise; `migrate --verify` reports the
same as `ownerSeesSessions` (CTO plan review 1; no `pg_read_all_stats` fallback). If any of those backends still
reads `state IS NULL`, settling stops with `CV500 settle_blind` and an error log line; NULL is never read as "no
transaction". Other roles' sessions are ignored. CranL's own `admin` sessions (its console, its managed `pg_dump`) are
the owner's and can hold the settle point back; `community.settle_behind` names the blocking backend's pid and
application name (CTO 2). `settle_goal` and `settle_community` run at READ COMMITTED only (`CI500`) and are VOLATILE,
so the slice is read in a statement whose snapshot follows the session read (CTO 3).
**Why:** only those two roles can write ledger rows, so only their transactions can still add rows to a slice; a host's
monitoring session the owner cannot see would otherwise stop settling for good.

## ADR-225 — Community counting details
**Status:** Proposed (Claude, 2026-10-24; T-306b plan). Q-189.
**Decision:** contributors are written from every committed row the tick reads (settled slice and tail) and never
removed; a reached `contributors` step is topped up with contributors whose first counted row is older than the reach,
until the settled point passes it. A removal counts only when the entry it reverses was counted (inside the window,
not rehearsal). In a points goal a contributor earned more than 0 points. Reaching the goal step finishes the goal at
once. A category goal reads each quest's current category. `/live` shows the running goal, or the latest one finished
in the last 30 minutes.
**Why:** reaching is judged on settled plus tail, so a payee list made from settled rows alone would miss players whose
only row was in the tail; the other rules keep the bar from moving for activity outside the window.
**Build notes (T-306b plan, 2026-10-24):** the payer takes the event `FOR KEY SHARE` after the rehearsal row and before
the enrollments, as `remove_award`, so `confirm_results` and a batch serialise. `event_has_open_poll` is replaced by
`event_has_live`.

## ADR-226 — Community switches and the owner's settle
**Status:** Proposed (Claude, 2026-10-24; T-306b plan). Q-190.
**Decision:** the event's `community` switch turned off finishes every running goal at once (`reached` if its goal
step was reached, else `missed`; reached steps still pay) and keeps scheduled goals from starting; the tick still
finishes a scheduled goal whose window ended. The platform switch off hides the bar and refuses the builder, but goals
already running keep counting and paying. "Settle and pay now" settles past the 30 s lag but never past an open
transaction from the window (`409 community_settling`, Retry-After 5), and pays for up to 20 s a call (`paying` asks
the dashboard to call again).
**Why:** an owner's off switch must end the goal players see; a platform switch is a display kill switch and should
not cancel rewards already promised; the owner's settle must be quick but never read a slice that can still change.
**Build notes (T-306b, 2026-10-24, CTO plan review 4):** the off switch sets `final_at = now()` with no top-up, so a
contributor whose first counted row was still in an open transaction at that moment is not paid for a step already
reached. Accepted: the owner chose to stop the goal; the window between a row's transaction and its commit is under
the 5 s statement limit.

## ADR-227 — The community unlock
**Status:** Proposed (Claude, 2026-10-24; T-306c plan, CTO plan review 84 folded in). Q-191.
**Decision:** a community step's `unlock` reward names one quest, category or shop reward of its event. The target is
locked from the moment the goal is saved until the step is reached (`community_reach`), the same for every player, and
a target can be locked once in the event's life. A live poll, a removed reward, another event's item, or the quest or
category the goal counts (or the counted quest's category) cannot be a target. An owner's or editor's manual award
passes the lock like every category rule; an operator's capped award does not. A missed lock never blocks another
quest or category (left out of the in-order, cleared and done checks; a missed whole-category lock counts as met). A
completion racing the goal's save may be paid; a reservation cannot (the reward row serialises them).
**Why:** one gate read by every door, with no per-player state, keeps the lock simple to check everywhere; locking at
save keeps a target from being played before its goal opens.
**Build notes (2026-10-24, T-306c):** the category bonus is paid only by a completion (`pay_category_bonus`, as
before): a player who finished every other quest of a category while one of its quests waited on a lock is paid the
bonus by their next completion in that category once the lock is missed, and not at all when none is left. Accepted
(CTO plan re-review note 1, Q-194); the goal's settle does not pay these bonuses, since it would lock and pay every
player of the event inside the tick's transaction. `community_lock_missed` also counts a milestone left unreached on
a goal that ended `reached` (CTO note 2; the builder's rules make that state unreachable, the rule holds anyway). A
draft event's delete cascaded to its quests before its goals and was refused (0053's counted-quest key had the same
trap; NO ACTION keys do not help, each cascade checks at its own statement's end): a `BEFORE DELETE` trigger on the
event deletes its goals first, and 0053's keys stay `RESTRICT`. `category_lock` is split into the community check and
`category_rule_lock` (the old rules), so the quest list reads the lock once a row. `member_game` answers QN403
`community_locked` instead of no row (its reader expects one row). The category gets its own `communityLock` in the
quests answer, shown once as the category's note. CTO code review (91 GO): an unlock is also refused (`unlock_counted`)
for what another goal not yet final counts, and a goal may not count what another goal's waiting step locks, so two
goals never hold each other back; the event switch off now ends scheduled goals missed too (their locks read "missed",
not "starts …"); the bar's padlock is the brand icon (`icon-padlock`), not an emoji.

## ADR-228 — How a locked item shows
**Status:** Proposed (Claude, 2026-10-24; T-306c plan). Q-192.
**Decision:** a locked quest or reward stays listed where the player already saw it, with a line naming the goal and
its threshold (or when the goal starts, or that it was missed), never the target; its sheet's content is not served;
the public event page leaves it out until unlocked; a closed live poll's results are not shown and Send is refused
while its poll is locked. The bar names the target only to a player who sees it ("a surprise" otherwise). A pinned
locked reward shows its lock on the Home goal card; the automatic pick skips locked rewards. The app refetches on the
reach and shows a one-time card.
**Why:** the lock is a teaser for the community goal, but must never reveal a hidden category or an item outside the
player's audience.

## ADR-229 — Missed unlocks and rehearsal
**Status:** Proposed (Claude, 2026-10-24; T-306c plan). Q-193.
**Decision:** a step missed, or ended by the event's community switch, leaves its target locked for the rest of the
event, with no owner override; the switch's confirm and the builder form say so. In rehearsal targets stay locked
(goals do not run there, Q-186). The gate only reads reach rows, all written after the go-live wipe, so nothing
unlocks in rehearsal or re-locks at go-live.
**Why:** an unlock given on a miss is not a reward; an override is a feature nobody has asked for yet.

## ADR-230 — T-307 is split in two
**Status:** Proposed (Claude, 2026-10-24; T-307 plan).
**Decision:** T-307 builds flash quests and double-point boosts (FR-251, FR-252). T-307b builds the live finale
(FR-254, FR-255, FR-1621) after T-504; its design is in the T-307 plan. The finale's reveal calls the owner's
`POST …/results/reveal` and never decides winners.
**Why:** the finale is a big-screen scene, and the big screen, its pairing and its reader rule (T-504, T-309) do not
exist yet; a finale page of its own on the dashboard would duplicate T-504's scene player. Boosts touch every quest
payer and need their own review.

## ADR-231 — Flash quests
**Status:** Proposed (Claude, 2026-10-24; T-307 plan). Q-195.
**Decision:** a flash quest is any quest but a live poll with `flash` set. It is launched now for 1 to 1,440 minutes
(once; a rehearsal launch goes back to draft at go-live) or scheduled with both an opening and a closing time; End now
closes it early (any time left, but not before a scheduled one starts). Players see it only inside its window (never
on the public event page). It stays out of every category rule, as live polls do. Once launched it cannot be turned
back into a normal quest. The event's `flashQuests` switch hides it and its doors refuse it. The 1-minute minimum is a
refusal of the launch and the builder, not a table check (CTO plan review 1).
**Why:** a "drop" that shows only while it runs; leaving it out of the category rules means a missed flash quest
never holds back a bonus or an unlock.
**Build notes (T-307, 2026-10-24):** the platform's `flashQuests` switch is read by the database too (`flash_on` reads
`platform_setting`), so every door and reader honours it at once with no API check per completion. A visible flash quest
with its own times is not launched by hand (`409 flash_scheduled`): hide it first. The builder's refusals keep its one
`field` (`flash`, `flashWindow`, `flashLaunched`), not `issues`.

## ADR-232 — Double-point boosts
**Status:** Proposed (Claude, 2026-10-24; T-307 plan). Q-196.
**Decision:** a boost doubles (×2) the quest payments of one category (a "zone" is a category under the event's own
word, F-187) for 1 to 1,440 minutes, started now or scheduled; two boosts of one category never overlap; at most 100 an
event; a scheduled boost can be edited or deleted until a minute before it starts (and never once an entry names it),
a started one only stopped. A rehearsal boost (saved before go-live, starting before the event) is the one boost
outside the event's window: it ends by the event's start and is checked for overlap apart from real ones. The
doubled amount is written into the quest's own ledger entry with `boost_id`, so the score, the ranking rebuild,
removals, today's ranking and results need no change. Boosted: every quest payment from a player's own act (scan,
code, location, my-QR, vote, live poll, survey, share, passport, meet, submission, quiz, game). Never: the category
bonus, items, community rewards, manual quest awards and point awards, welcome points, XP.
**Why:** one entry per payment keeps the ledger the only source of the score; staff awards keep their caps exact.
**Build notes (T-307, 2026-10-24):** a boost saved while the event has no start is a rehearsal boost; if a start is set
later, before that boost ends, the edit is **accepted** (CTO plan re-review note 2): the boost keeps paying and showing
to rehearsal accounts only, real players are paid ×1 and see no ×2, and the go-live wipe deletes it (tested). Stop is
refused before a boost starts (`not_started`; Delete until a minute before), so in the minute before its start a boost
can be neither changed nor stopped.

## ADR-233 — When a boost applies
**Status:** Proposed (Claude, 2026-10-24; T-307 plan). Q-197.
**Decision:** a boost is judged at the time the quest's points were fixed: the completion, a submission's send, a
quiz's start, a game round's issue. It is looked up by that time; since a window never moves once it starts (only Stop
shortens it to now), the answer never changes. The event's `boosts` switch off stops every boost paying at once; the
platform switch only stops new ones. A community points goal counts the doubled points, and a player's pending
submission points show what approval will pay. One rule (`boost_in_force`) decides for the payers and the readers: a
rehearsal boost applies to and is shown to rehearsal accounts only, a real one to real accounts only; the go-live wipe
(and the team's erase) deletes rehearsal boosts after the rehearsal entries. The lookup reads the quest's category at
payment (a quest moved between a send and its approval follows its new category). Every `pay_completion` caller
passes the time explicitly (no default), held by a completeness test over every function.
**Why:** what the player saw when they acted is what they get, whatever the review or finish delay, with nothing new
stored on submissions, quizzes or rounds.

## ADR-234 — NFC tags: basic tags
**Status:** Proposed (Claude, 2026-10-24; T-308 plan). Answers Q-071; ADR-040 stands (signed NFC tags not chosen;
Dhia, 2026-10-24: basic tags only, Q-198). Q-199.
**Decision:** a **basic tag** (any NTAG213/215/216 sticker) holds a signed Questify URL of its own (`/t/{token}`, code
purpose 0x06: the tag's id and version; the quest is looked up on the server, so a tag can be moved to another quest of
the event). It is as strong as the printed quest QR; a tap whose sticker id (told by the phone) is not the one
registered at writing, or is missing, counts on the tag's copy count and is still paid (ADR-041); the account is
flagged `nfc_copy` from its second such tap since its last closed case. An iPhone build that cannot read the id sends
`uidReason: "platform"` (accepted from the iOS build only, without an id): the tap is paid, not checked, never flagged,
and counted apart on the Tags panel (CTO A). A retry after a Revoke or Move replays the paid tap. Writing takes a
prepare that answers a fresh tag id, its URL and a 5-minute signed ticket (event, quest, operator, tag) that the
confirm requires (CTO B); a second confirm of one tag answers 409 `already_registered` (CTO C). NFC is offered on scan
quests only and always with the quest QR on (phones without NFC, a torn-off tag). Tags are written from staff mode on a
phone (the `write_nfc` ability), never from the web dashboard; "Lock the tag" is on by default and permanent.
Regenerating a quest's QR does not revoke its tags; each tag is revoked or moved on its own. While the platform's
`nfcTags` switch is off, taps and writes are refused but the team's Tags panel (list, Move, Revoke) stays open (CTO
code review 4). A quest with an active tag is not deleted (`tags_in_use`); once its tags are revoked the delete
removes the tapless ones and detaches the tapped ones (kept as the taps' evidence). Tags carry no version: every tag
is written at version 1 and any other signed version is refused.
**Why:** research 2026-10-24 (plan `docs/plans/2026-10-24-t-308-nfc-tags.md`, Q-071 table): `react-native-nfc-manager`
v4 reads and writes NDEF on both phones; no Saudi figure for phones without NFC exists, and budget Android lines still
ship without it.

## ADR-235 — T-308 split into basic and signed tags
**Status:** Rejected (Dhia, 2026-10-24): basic tags only; signed tags will not be built.

## ADR-236 — Signed tags: keys, personalisation and replay
**Status:** Rejected (Dhia, 2026-10-24): basic tags only; signed tags will not be built.

## ADR-237 — The NFC library
**Status:** Proposed (Claude, 2026-10-24; T-308 plan). Confirms TECH_STACK's Proposed row.
**Decision:** `react-native-nfc-manager` v4 (4.1.0, MIT, New Architecture, validated on Expo SDK 57) with its config
plugin (`NFCReaderUsageDescription` in Arabic and English, the NDEF and TAG entitlement; no ISO 7816 select
identifier). The library's own Android manifest declares the NFC feature not required, so no plugin of ours is needed
(checked in its manifest). It is loaded lazily, only when a screen asks, so a build without it never crashes. No second
NFC module. Adding it needs a new EAS build.
**Why:** one maintained module covers NDEF reading and writing on both phones.

## ADR-238 — T-309 is split in two
**Status:** Proposed (Claude, 2026-10-24; T-309 plan).
**Decision:** T-309 builds pairing for stations, kiosks and big screens, the device credential, revocation and the
rotating screen QR (FR-314, FR-1713). The kiosk and its live code (FR-315) move to T-309b (migration 0058), whose
design is fixed in `docs/plans/2026-10-24-t-309-stations-kiosks-pairing.md`.
**Why:** three core pieces (a credential, a rotating proof, a door with no staff present); the kiosk needs both others.

## ADR-239 — Device pairing
**Status:** Proposed (Claude, 2026-10-24; T-309 plan). Q-204.
**Decision:** an unpaired station, kiosk or big-screen page shows an 8-character code (10 minutes, about 40 bits) and
holds its own secret in an HttpOnly `__Host-qs_device` cookie, stored only as its hash; nothing of any event shows until
staff claim the code. Operators claim from staff mode (stations with `show_rotating_qr`, kiosks with `scan_quests`,
within their quest limit); owners and editors from the dashboard (any kind; big screens only there). A device works
until it is revoked, its operator is removed, its quest or event is deleted, 24 hours after its event ends, or after 30
idle days. Once paired, the device's secret is replaced (`activate`; the old one lives at most 60 more seconds) before it sees anything of the event. A device paired by an operator works only while that operator still has the ability and the quest (else it is paused). Removing an operator or a team member revokes what they paired; who paired stays in the audit. One venue address may open 60 requests in 10 minutes, and a page that already holds a cookie never opens another. A new `device` access kind lives under `/v1/device`. Secrets and codes never appear in a URL, log or audit. (CTO plan review 2026-10-24.)
**Why:** the TV sign-in pattern: the device types nothing and its credential is never shown, so a shared link or a
photographed code opens nothing (FR-1713).
**Build note (T-309, 2026-10-24):** the cookie is looked up by a definer that takes its hash (`device_session`, as
`player_session_owner` does for players) rather than a new pre-identity setting; the guard then sets `app.device_id`.
Only hashes of codes are stored, so `GET /v1/device` answers a pending page without its code and a reloaded page asks
for a fresh one under the same secret (`renew`). Staff see what the screen said it is before confirming (`POST
…/devices/preview`, counted as a claim), and a claim names the page's kind (`wrong_kind` otherwise). Staff mode pairs
stations only until T-309b adds the `kiosk` method (a kiosk claim answers `not_kiosk`). The removal triggers do nothing
without active devices and delete, rather than revoke, the devices of an event being deleted (CTO plan re-review 1).
The operator's phone keeps its screen on with `expo-keep-awake` (~57.0.2, already in the build through expo@57.0.30, so
no new native module; CTO code review 6). A pairing request renews for at most an hour after it was made, and renew and
activate take 10 a minute per device (CTO code review 1).

## ADR-240 — Rotating screen QR
**Status:** Proposed (Claude, 2026-10-24; T-309 plan). Q-203.
**Decision:** a screen code is purpose 0x07: the quest id and the 30-second window number, both issued and judged on
the database clock (never the screen's or the phone's). The previous window is accepted for the first 15 seconds of
the next. Not single-use. The method `screen_qr` is offered on scan quests only and never with the printed quest QR.
It shows on a paired station page or on an operator's phone (`show_rotating_qr`). One pay per player per window (45 seconds). Codes are per quest: revoking one station does not stop the quest's codes on other stations or phones.
**Risk accepted:** a code relayed live within its 45 seconds pays its scanner; bounded by the quest's caps and period
and watched by the burst flags.
**Why:** FR-314: a photo shared after the code changed must not pay; one clock removes clock skew.
**Build note (T-309, 2026-10-24):** a station's answer names why it shows no code (`paused`, `method_off`, `hidden`,
`not_started`, `ended`, `event_ended`); a Draft or Scheduled event shows codes for rehearsal accounts. An expired code
answers 422 `code_expired` ("This code has changed. Scan the screen again"). The platform tuning
`screenQrRotationSeconds` was removed (Q-206, CTO code review 5).

## ADR-241 — The big-screen link holds nothing
**Status:** Proposed (Claude, 2026-10-24; T-309 plan). Q-202. Amends FR-1713's "regenerate a big-screen link".
**Decision:** the big-screen link is the plain `/{lang}/screen` address; a screen works only once paired, and the
dashboard's "Revoke all big screens" takes the place of regenerating the link.
**Why:** with pairing, a link carries no power, so there is nothing to regenerate.

## ADR-242 — Kiosks read a live code
**Status:** Proposed (Claude, 2026-10-24; T-309 plan, built in T-309b). Q-201. Amends FR-315 ("live code" for "live My
QR"); ADR-137 stands for stations and the prize desk.
**Decision:** a kiosk reads the player's **live code** (purpose 0x08: the player id and the 30-second window, judged
as screen codes are), shown in My QR's "For kiosks" tab while online; the fixed My QR is refused with a hint. Method
`kiosk` on scan quests; one pay per live code (45 seconds) under the enrollment lock. The kiosk is a web page on any
tablet, decoding with `zxing-wasm` 3.1.5 (reader only, wasm self-hosted), with the camera allowed on that route only.
**Risk accepted:** a live code relayed by video within its 45 seconds pays its owner.
**Why:** the fixed My QR (ADR-137) works from a screenshot for ever, which only a watching operator mitigates.

## ADR-243 — Android NFC sessions hold reader mode
**Status:** Proposed (Claude, 2026-10-24; T-308 phone-test fix). Q-205. Amends the T-308 plan's Android session.
**Decision:** on Android every tag session (the scanner's tap, Write NFC tag) turns on reader mode itself
(`registerTagEvent` with `isReaderModeEnabled`, NFC-A/B/F/V) before `requestTechnology([Ndef, NdefFormatable])`, and
turns it off itself when the session ends; sessions run one at a time, and one stopped while it waited its turn never
starts. NFC switched off answers at once (`off`, with a hint). A factory-blank sticker (NdefFormatable) is formatted
with the message, locked in the same step when asked, with no read-back (Android reports the format only once the
message is written). A tag with neither NDEF nor NdefFormatable (a MIFARE Classic card on most phones) is refused in
the app as `unusable`. Once an NDEF write went through, only a read-back showing another message fails it: a tag
pulled away before the read-back or the lock is answered as written and unlocked, so the server registers the link it
holds (a refused lock is registered as unlocked and said on screen). The "already holds a Questify link" refusal says
the link may not be registered.
**Why:** the T-308 build asked for no reader mode, so the library fell back to foreground dispatch, and its cancel
turned the registration off a second later, under a newer session. On Dhia's phone a sticker and a card met Android's
"Could not find an app that supports this NFC tag" on the write screen while an NDEF fob was written. The fob's link was then unknown to the server (CranL: no `nfc_tag` row and no
`nfc_tag.*` audit entry, so no confirm ever committed): a write that failed after the NDEF write (the fob moved before
the read-back or the lock) left a signed link on it, and the next tap answered "already holds a Questify quest", which
reads as success.

## ADR-244 — What a kiosk shows and refuses
**Status:** Proposed (Claude, 2026-10-24; T-309b plan, `docs/plans/2026-10-24-t-309b-kiosk.md`). Q-208. Builds on ADR-242.
**Decision:** a kiosk is a public screen. Its green and orange cards show the scanned player's @username and avatar
only (never a score, balance, rank or status); a red card names no one, and a reason that would describe the person
(banned, paused, removed, left) reads "This quest isn't open to you now". The operator who paired a kiosk cannot be
paid by it (`self_scan`). The door namespaces its keys as `kiosk:{device}:{uuid}`, and `record_completion` refuses a
`kiosk:` key with any other method and the kiosk method with any other key. A kiosk never sets the player's install id
(so it raises no `shared_device` flag) and never queues a scan offline. The ledger's actor is the player; `kiosk_scan`
names the kiosk. The door holds the device `FOR SHARE` and never locks the operator's assignment (the removal trigger
locks the assignment, then the device).
**Why:** no one watches a kiosk, and anyone standing near it reads the screen.
**Build notes (2026-10-24, T-309b):** the one-pay rule is per method: a quest with both the screen QR and the kiosk can
pay one presence twice within 45 seconds (once by each), within the quest's caps; accepted, each method is its own way
in. The reserved-key check is null-safe (`(coalesce(request_key, '') LIKE 'kiosk:%') IS DISTINCT FROM (proof_method =
'kiosk')`, CTO note 1). `boosted` is read from the ledger entry by completion id, on a replay too. An operator who may
not play (QP403) reads `not_open` on the card like every other personal reason. FR-1415's blocked user: a kiosk names
the @username of a player another player has blocked like any public board does; blocking hides people from each
other in the app and was never a way to hide from a public screen at the venue.

## ADR-245 — The kiosk page's decoder, headers and limits
**Status:** Proposed (Claude, 2026-10-24; T-309b plan). Builds on ADR-242.
**Decision:** `zxing-wasm` 3.1.5 (`zxing-wasm/reader` only), loaded by the kiosk page alone; its wasm file is committed
as `apps/web/public/zxing/zxing_reader-3.1.5.wasm`, checked by a test against the installed package's file, never
fetched from the library's CDN; frames are decoded on the tablet at 4 a second (at most 640 px), on the main thread,
and no frame leaves the page. Only `/ar/kiosk` and `/en/kiosk` get `camera=(self)` and `'wasm-unsafe-eval'`. The
front camera by default, with a switch. 30 scans a minute per kiosk; 10 unreadable or forged codes in a minute pause it
until the minute passes. The platform switch `kiosks` (on by default; the paid add-on of ADR-076 gates it later).
**Why:** Safari has no `BarcodeDetector`; one decoder everywhere, with no third-party origin at run time.
**Build notes (2026-10-24, T-309b):** 3.1.6 (2026-10-19) was still inside the 7-day cooldown at build, so 3.1.5 stays,
pinned exactly; `pnpm audit` clean of new advisories. Every link to the kiosk page is a plain `<a>` (a full page load),
so the page always runs under its own `Permissions-Policy` and CSP (CTO note 4; an e2e test clicks through from the
Devices page). The web image now copies `apps/web/public` (the standalone server serves nothing from it otherwise; the
currency icons were missing there too). The six default avatars are copied to `apps/web/public/avatars` for the cards.
While the switch is off, `GET /v1/device` answers a kiosk `shut: feature_off`, so the page shows "Not available"
without waiting for a scan. The live code's window comes from a granted `live_code_window()` (the internal
`screen_window()` stays closed). The bad-code limit is keyed apart from the device's polls, so a poll never holds a
scan back.

## ADR-246 — Help-desk tickets: one closed table, one answer
**Status:** Proposed (Claude, 2026-10-24; T-310 plan, `docs/plans/2026-10-24-t-310-help-desk.md`). Builds on ADR-105.
**Decision:** A help-desk ticket is one row of a closed `ticket` table (RLS forced, PUBLIC revoked, no grant; definers
are the only doors). T-310's kinds are `question` and `problem`, its only queue is `event`. A ticket is open, then
closed as `answered` (the team's one reply, ADR-105) or `solved` (closed with no reply); a further question is a new
ticket. The player sees the answer signed "The event team", never a person. The columns and CHECKs are laid out so
T-312 widens the kinds and queues (`questify`), allows the event columns NULL for a ticket outside an event, and adds
escalation, without moving data. FR-338's "reply and mark it solved" reads as these two outcomes (pending Q-081).
**Why:** ADR-105 fixed one reply; one table that T-312 extends avoids building the help desk twice.
**Trade-offs:** No follow-up in the same ticket; if Q-081 allows one, the reply moves to a message table.

## ADR-247 — Who sees a help-desk ticket
**Status:** Proposed (Claude, 2026-10-24; T-310 plan).
**Decision:** The sender reads their own tickets in any enrollment status while their account is active. Owners and
editors in the event's scope read and answer every ticket of the event. Operators with `help_desk` read and answer open
tickets where `quest_id IS NULL OR operator_reviews_quest(...)`, never their own, and read a closed one only if they
answered it, never learning who else did. A deleted quest sets its tickets' quest NULL, so they become visible to
every `help_desk` operator (accepted). The player's reads never carry who answered. No other player, and no Questify admin, reads a
ticket until T-312's escalation (Q-211). The team sees the player's @username and avatar, never a contact, name or birth
year. Staff answers are audited without the text; operator answers are recorded on the row. Text never reaches logs,
errors, audit rows or push text.
**Why:** FR-339: private between the player and the event team; the same limits as the submission queue.

## ADR-248 — Sending, limits, notice and retention of tickets
**Status:** Proposed (Claude, 2026-10-24; T-310 plan).
**Decision:** Active members of a scheduled, live or ended event send tickets, until 30 days after the end, while the event
switch `helpDesk` (on by default) is on; only sending stops in any other state: Your requests (per event, and every
event's in the profile) stays reachable whenever the player has tickets; at most 3 open and 10 in 24 hours per player per event, checked in the database; text 1 to 1,000
characters, word-list hits mark (FR-1628). No help-desk mute: a ban stops sending. Until T-501 the player learns of an
answer from a Home strip and a dot in Your requests; T-501's push has fixed text and never the question or reply.
Tickets are deleted with the account at once and 90 days after the later of the event's end and the sending (the
lifecycle tick; Q-210). The
optional photo (FR-337) moves to T-301b, which owns the one photo pipeline (blocked on Q-149). Get help links the existing web contact
page (Settings → Legal, T-110), which with App Store Connect's Support URL meets Apple 1.5.
**CTO plan review 2026-10-24 (86/100):** findings folded into ADR-246 to ADR-248 and the plan.
**Why:** Bounded spam with no cache; PDPL minimization; one photo pipeline.
**As built 2026-10-24 (T-310, CTO re-review 93 notes):** `mark_tickets_seen` takes a NULL event (still only the
caller's own closed tickets), so the profile's Your requests marks every event's answers in one call
(`POST /v1/me/tickets/seen`). The refusals are named apart: `sending_closed` (HT403) for a draft or archived event or 30
days after the end, matching `help.sendClosed`; `event_closed` (HT409) for answering in an archived event. Staff accounts
have no display name, so "Answered by" names the staff member's email (as flag resolutions do). The inbox cursor carries
`created_at` in microseconds (a JavaScript Date keeps milliseconds). The app has no ban screen (a 403 Home forgets the
event), so a banned, left or removed player reads their answers in the profile's Your requests. Every event a ticket
can be sent in has an end (`event_times_once_active`), so the 90-day sweep has no gap. CTO code review (93 GO): one
answerer's key is held under an advisory lock in `answer_core`, so the same key on two tickets at once is `QK422`, not a
unique violation (the API maps that index's 23505 to `idempotency_key_reused` as a backstop); the ticket reads and seen
marks take a per-player limit of 60 a minute, the operator's Inbox reads 60 a minute (`too_many_attempts`).

## ADR-249 — A practice scan runs the real door and the database undoes it
**Status:** Proposed (Claude, 2026-10-24; T-311 plan).
**Decision:** Practice scans (FR-929) go to their own route, `POST /v1/operator/scan/practice`, which calls
`operator_practice_scan`, a `SECURITY INVOKER` wrapper around the real `operator_complete_quest`. The wrapper runs the
real call in a PL/pgSQL block and then raises unconditionally (`PX000`), so the database rolls back everything the call
wrote and keeps only the would-be points and occurrence; any refusal lands in the same handler. The key is fresh and
marked `practice:`. The API runs it in a transaction that always rolls back, reads the scan subject there, has no
ranking dependency and takes no Idempotency-Key. The real route has no practice flag. Unknown SQLSTATEs are a 500,
never a red result.
**Why:** the result screens must be the real ones (every rule, boost and refusal) with no second copy of the rules to
drift, and no single bug may write points: the database wall alone, the API wall alone and the separate route each
prevent it, and each is tested alone (a whole-database fingerprint before and after).
**Cost:** a practice scan costs a real scan's work; identity numbers it used are skipped (gaps only).
**Build note (2026-10-24, T-311, CTO plan review 92 GO):** a third function, `practice_wipe_owed` (definer, granted,
true only for an operator of the quest's event), lets the practice answer `PW409` (red `going_live`, "try again in a
minute") while the event's go-live wipe is owed, instead of running the whole wipe under the rehearsal row's lock and
throwing it away on every practice scan (MINOR-3). The invoker wrapper sets `search_path = public, pg_temp`. A failed
outer ROLLBACK destroys the pooled connection (MINOR-8). The station-today refusal outside the quest limit reuses the
existing `403 outside_quests` (the plan said `outside_station`).

## ADR-250 — Practice mode covers station scans only and locks the writing tools
**Status:** Proposed (Claude, 2026-10-24; T-311 plan).
**Decision:** Tools → Practice mode is a switch held in memory for the staff-mode session (never stored; off after
leaving staff mode or restarting). While on, every staff screen shows "Practice: nothing is saved", the station scan
(scan and challenge quests) uses the practice route and its result cover adds "Practice · not saved", and the Desk and
Inbox tabs, Manual award, Review, Write NFC tag, Rotating QR, Pair a device and My devices show a lock card with Leave
practice. NFC taps, screen QR and kiosk scans are made by players or devices, not the operator, so they are not
practised. Before doors open, a green is practised with a rehearsal account (T-211). Q-212 asks about practising more.
**Why:** the strip's promise stays true and no operator hands over a prize or awards points believing it is a test.
**Build note (2026-10-24, T-311):** the strip renders from the shared screen frame whenever staff mode's practice is
on, so every staff screen has it; the operator's ticket screen is locked too (it answers tickets). The result line
comes from the server's `practice: true`, and a mode change forgets the last code (MAJOR-1) but keeps a real scan's
pending key, which practice scans never send or clear, so a retry after a lost reply replays (code review MINOR-1).

## ADR-251 — My station today counts the station's quest for everyone; waiting is the Inbox count
**Status:** Proposed (Claude, 2026-10-24; T-311 plan).
**Decision:** Operator Home's "Today at this station" (FR-928) counts completions of the picked station's quest by
every method and operator in the event's day (timezone and day start hour) and in the last 60 minutes, through
`operator_station_today` (operator of the event, a station quest, inside the quest limit; counts only). Waiting items
are T-310's Inbox count, read once for the badge and Home every 30 s. The station list keeps this operator's own counts.
The read is limited to 60 a minute per player. Q-213 asks whether only this operator's scans should count.
**Why:** two operators at one booth see one truth; an indexed range count costs a few milliseconds.

## ADR-252 — The event's words reach every text through the translator
**Status:** Proposed (Claude, 2026-10-24; T-311b).
**Decision:** The event's quest, category and player words are message placeholders the translator fills in, so a
screen never passes them: `{questOne}` and `{questMany}` as typed, `{questOneCap}` and `{questCap}` with a capital
(the same four for `category` and `player`; `wordParams` in `packages/shared/src/config/terms.ts`). The root translator
fills Questify's own words; inside an event and inside staff mode, `TermsScope` fills the event's. A screen's own value
for the same name wins. The parity test between Arabic and English ignores these names, because Arabic often cannot
take a renamed noun where English can (ADR-253); an admin's text override still keeps each language's own set. The
existing `{player}`, `{quest}` and `{category}` placeholders stay what they were: a username and titles.
**Why:** about 90 texts name a quest or category; passing the words at each call site would miss some and show
Questify's word by mistake. A test (`apps/app/src/i18n/words.test.ts`) reads every key the staff and event screens
name and fails on a hard-coded «مهمة/فئة» or "quest/category".

## ADR-253 — Arabic uses a renamed noun only where it needs no article, agreement or count
**Status:** Proposed (Claude, 2026-10-24; T-311b; Arabic lines checked with `ux-araby`).
**Decision:** In Arabic a renamed noun stands only as a label or heading («{questMany}», «{questOne}: {title}»), as an
indefinite object after a verb («أنجز {questOne} لتدخل الترتيب»), in a construct («جائزة {questOne}», «مكافأة إكمال
{categoryOne}») or after لا. Every other sentence is rephrased with no noun and no gendered pronoun for it («انتهت المدة
المحددة»، «هذا غير متاح الآن»، «لم يحن موعد البدء بعد»), while English keeps the noun ("This mission has ended."). Two
feature names that cannot be a label are rebuilt without an adjective that must agree: community quest «{questOne}
للجميع», flash quest «{questOne} بوقت محدود!». Staff mode's player word follows the same rules (FR-941): «رمز
{playerOne}», and the manual award's search no longer names the player («من تمنح؟»).
Operator cards name the station, a fixed noun («المحطة غير متاحة الآن»). The Event words form tells the organizer to
write each Arabic word without «ال» (`terms.arHint`); a leading «ال» is **not** stripped on save, because it is not safe:
it is part of real words («الماس») and a typed definite form is still valid text. The player word is rephrased the same
way in the event's player texts (meet, community, waitlist).
**Why:** ADR-058 asks for rephrasing where a sentence cannot absorb a variable noun; a masculine noun such as «تحدٍّ»
would break «هذه المهمة جماعية»-style agreement.

## ADR-254 — Staff mode reads the event's words from the same cached configuration as the player app
**Status:** Proposed (Claude, 2026-10-24; T-311b).
**Decision:** `OperatorProvider` loads `GET /v1/events/{id}/config` through `loadEventConfig` (cached copy at
`questify.config.<eventId>` first, then the fresh one) and offers `terms` to staff screens (`useOperator().terms`); its
screens use the event's currency (the review queue's amount, the desk's cancel text), and the award search no longer
names the player. Questify home and Questify-level texts keep the defaults (FR-942). The dashboard builder's headings
and labels keep Questify's words until T-311c.
**Why:** one source for the words, so the two apps cannot disagree; it fixes the FR-941 gap Q-214.

## ADR-255 — T-312 splits off the notification history
**Status:** Proposed (Claude, 2026-10-24; T-312 plan, `docs/plans/2026-10-24-t-312-ticket-center.md`).
**Decision:** FR-1824's notification history moves to T-312b (depends on T-501): no notification is stored anywhere
yet, and T-501 builds the notification center (FR-1104). T-312b is the profile row and the full list on T-501's table,
not a second store. T-312 delivers My tickets (the profile's Your requests).
**Why:** nothing to list until T-501; building a store first would duplicate T-501's.

## ADR-256 — Ticket types and routing
**Status:** Proposed (Claude, 2026-10-24; T-312 plan). Answers Q-209 as recommended.
**Decision:** Four cards, six stored kinds: `question`, `problem` (T-310's), `prize` and `report_player` go to the event
team; `app_problem` and `suggestion` go to the Questify team and never carry an event, even when sent from inside one.
The routing is fixed by the kind in the table's CHECKs; an event kind reaches Questify only by escalation. Reports of a
player go to owners and editors only, never to operators. Report a player names a member of the same event by
username; one open report per reporter and reported; the reported player is never told. Failed username lookups are
capped at 10 an hour per player and event (the lookup can reveal a member the board does not show).
**Why:** FR-1822; operators are often players, and a report names someone.
**Trade-offs:** an app problem sent from an event does not show the event to its team (the text can name it).

## ADR-257 — Who sees a ticket after T-312
**Status:** Proposed (Claude, 2026-10-24; T-312 plan). Replaces ADR-247's visibility table; answers Q-211.
**Decision:** A platform admin reads exactly the tickets with `queue = 'questify'` (app problems, suggestions, and event
tickets while escalated or after Questify closed them), only through the console's definers, each re-reading
`app_admin_id()`; a ticket sent back leaves the console. Every console read and action is audited with ids (and the
event's ids for an event ticket), never text; a list page writes one row per event shown, holding the ids shown. The event team reads its escalated tickets read-only. The player sees
which team answered ("The event team" / "The Questify team"), never a person or a note. The event cards' privacy line
says Questify may read the ticket if the team asks for help.
**Why:** FR-1823 needs Questify to read escalated tickets; a single rule keeps the new cross-tenant reader narrow.

## ADR-258 — Escalation to Questify
**Status:** Proposed (Claude, 2026-10-24; T-312 plan).
**Decision:** Owners and editors in scope escalate an open event ticket with a required note; the ticket moves whole to
the Questify queue (it leaves every operator's inbox and the team's answer doors) and stays one of the sender's open
tickets. Questify answers or solves it (one reply closes it, whatever the event's state) or sends it back with a
required note; app problems and suggestions are never sent back; a returned ticket can be escalated again. FR-1823's
"take over" is Questify's own answer. Audit: `event.ticket_escalated`, `console.ticket_answered`,
`console.ticket_solved`, `console.ticket_returned`, `console.tickets_read`, `console.ticket_read`.
**Why:** FR-1823 with the smallest door: no claims, no assignment, one queue column.

## ADR-259 — Sending outside an event and the device facts
**Status:** Proposed (Claude, 2026-10-24; T-312 plan).
**Decision:** `open_platform_ticket` sends app problems and suggestions with no enrollment, under a per-player advisory
lock and then the player row `FOR KEY SHARE` while active (erasure holds it `FOR UPDATE`, so no send outlives an
erasure): 3 open and 5 in 24 hours in the Questify queue per player, replays by key. An app problem carries the app version,
platform, OS version and phone model; the model comes from `expo-device` (new dependency: iOS gives no model without
it; no permission, no identifier), loaded lazily so an older binary sends `null`; never the phone's own name.
**Why:** FR-1822's acceptance names the app version and phone model.
**Trade-offs:** a new native module needs a new development build.

## ADR-260 — The first-N count: one row per slot, claimed last with SKIP LOCKED
**Status:** Proposed (Claude, 2026-10-25; T-313 plan, CTO plan review 84 then 92/100).
**Decision:** A bonus is `quest_first_bonus` (points 1 to 100,000, N 1 to 1,000) and N rows of `quest_bonus_slot`. The
claim `pay_first_bonus` is each payer's caller's last write (record_completion, pay_submission, finish_quiz,
finish_game_round, stamp_step, pay_meeting; never inside pay_completion; the meet claims both sides after both pay, in
player id order). It costs a quest without a bonus one primary-key probe; a repeat, a manual award, a `practice:` key
or a used-up bonus takes no lock. Otherwise it takes the bonus's advisory lock shared (the setter takes it exclusive, so
an edit waits for the claims in flight and is never starved), reads the bonus again, takes the lowest free slot `FOR
UPDATE SKIP LOCKED`, writes a `first_bonus` ledger entry and the slot's claim (`claimed_at = clock_timestamp()`, so a
rank shown never moves for a transaction that started earlier and claimed later). The place shown is the claim's rank
by (claimed_at, place). Stop is a setter call that sets N to the number given, counted under the lock. The API reserves
`practice:` idempotency keys like the other system prefixes.
**Why:** a counter row or an exclusive lock queues every claimer of the entrance quest on one lock (NFR-002/003).
**Measured (2026-10-25, two pools of 10, 300 completions at once, N = 50, six rounds, median p95):** plain 59.7 ms, bonus
73.2 ms (+22.7%), used-up bonus 60.0 ms; exactly 50 paid each round. The slot claim alone is +7.5%; the rest is the
bonus's own ledger row (its triggers and indexes) for the first 50. Over the plan's 20% relative budget, by 13 ms in
absolute terms against NFR-002's 1 s (Q-229).
**Trade-offs:** a residual rank change is possible only for two claims committing within the same milliseconds.

## ADR-261 — Which completions take a first-N bonus
**Status:** Proposed (Claude, 2026-10-25; T-313 plan).
**Decision:** A player's first completion of the quest through any door, at its pay moment: the approval for a
submission (approval order decides), the finish for a quiz, the result for a game, the stamp that finishes a
passport, each side of a meet. Never a repeat, a period refresh, a manual award (which, as a first completion, uses up
that player's chance, Q-225) or a practice scan. A quiz swept by `confirm_results` or by the tick once the event is no
longer live claims nothing (no slot is taken after the event, and the places check never moves for a bonus); one that
timed out during play, swept by the tick while the event is live, claims as any finish (CTO note 1). Rehearsal claims
are given back by the go-live wipe and Erase rehearsal. The bonus is never boosted and pays no XP; a removal never frees
its slot (Q-223).
**Why:** FR-1840 rewards being early; the results-time sweep must not change the frozen places.

## ADR-262 — The first-N bonus in the builder
**Status:** Proposed (Claude, 2026-10-25; T-313 plan).
**Decision:** The quest save takes `firstBonus: {points, slots} | {stop: true} | null` and calls the setter in its
transaction after the quest write. Its points and switching it off lock once a real player got it (`first_bonus_paid`);
N may change to any value at least the number given (`below_given`); lowering deletes free slots from the highest place
down. The form shows the preview, the locked line and Stop; the list says "First {N}: {left} left"; the team's record
says "First-{N} bonus, place {place}" and the remove dialog of the quest line hints at the bonus line.
**Why:** every player of the first N gets the same amount; N stays the most ever paid.

## ADR-263 — "Bonuses left", live
**Status:** Proposed (Claude, 2026-10-25; T-313 plan).
**Decision:** `first_bonus_left` counts every bonus of an event (an active member or the team only; nothing for anyone
else), cached per event for 2 seconds in each API instance (one load in flight per event, a failed load never kept).
`/live` lists the bonuses of the quests the player may play now and never completed, with `left` from the cache (0
included), and `event_has_live` stays true while a slot is free and for 15 minutes after the last claim; the quests read
gives each quest `firstBonus {points, slots, left, mine}`; every completion answer gives `firstBonus {points, place,
slots}` (place null: all taken). The app's ribbon takes `left` from `/live` and never reads the quests again for it.
**Why:** `/live` runs every 10 s for every player; a count per player would be thousands a second at the entrance.
**Trade-offs:** "left" lags by at most 12 seconds; while a bonus has free slots every player's `/live` runs its query.

## ADR-264 — The dashboard's event pages say the event's quest and category words
**Status:** Proposed (Claude, 2026-10-25; T-311c; Arabic lines checked with `ux-araby`).
**Decision:** The layout of `/[lang]/organizers/{o}/events/{e}` reads the event once on the server with the staff
session (`fetchEventTerms`; any failure gives Questify's words) and offers its terms to every page below it through
`TermsScope`. Components call `useTranslator(language)` instead of `translatorFor(language)`; texts name the words with
ADR-252's placeholders. `translatorFor(language, terms)` now keeps one function per language and set of words (the key is
the words, the 32 most recently used events kept, Questify's own never evicted), so a new terms object with the same words gives the same
function and a panel that lists `t` in a hook dependency cannot reload in a loop again. Saving the Event words calls
`router.refresh()`, which reads the layout again. About 120 texts were rewritten under ADR-253, plus these Arabic forms: a
feature name is `{questMany}` before its qualifier («{questMany} المشاركة», «{questMany} للجميع», «{questMany} بوقت محدود»);
a switch's on and off lines open with «مفعّل:» or «متوقف:» and say «هذا النوع» instead of a pronoun for the renamed noun; a
community quest is «هدف» in running text; the secret code is «الرمز السري ل{categoryOne}»; the destructive choice is «حذف
الكل ثم حذف {categoryOne}». The Event words form, the public code page and the kiosk page keep Questify's words (Q-227).
The Arabic «{questMany} للجميع» against English "Community {questMany}" is accepted: «للجميع» says the same without an
adjective that would have to agree with a renamed noun. The form's submit is «إنشاء {questOne}», not «إضافة {questOne}»,
so it is never confused with the list's add button (assistive technology and the specs find buttons by name).
**Why:** the pages are client components that each read their own data; one server read gives the words before the first
paint, with no flash of the default word and no extra request per panel.
**Trade-offs:** one extra server-to-API read per event page load (5 s timeout); a change made in another tab shows after a
reload.

## ADR-265 — Model routing and independent reviews
**Status:** Accepted (Dhia, 2026-10-25).
**Decision:** Use GPT-6.1 Sol (`gpt-6.1-sol`, pinned in `config.toml`) for everything. GPT-6 Luna at High is allowed
only for purely mechanical edits. Reasoning effort is High for the coordinator, all plans, all reviews and core
builds; Medium for standard builds; Max only for the riskiest reviews. Every review, including a re-review, runs in
a fresh session or subagent, never the code author. This replaces the active Opus/Sonnet routing; historical records
keep their original model names. The existing config already pins GPT-6.1 Sol with High; no config edit is needed.
**Why:** Dhia explicitly set the model, reasoning effort and reviewer independence policy.
**Trade-offs:** workers and reviewers must select the task's reasoning effort explicitly where it differs from the
configured High default; the mechanical-edit exception never applies to plans or reviews.

## ADR-266 — Separate profile ownership from organizer souvenir rules
**Status:** Proposed (worker recommendation, 2026-10-25; Q-230).
**Decision:** T-402 builds the locker/equipment and public privacy boundary, guaranteed level-up items and next-level
reward. A new core T-402b immediately after it delivers all FR-723/FR-1622 souvenir rules and dashboard grants, using
that ownership primitive. FR-701/702 stay partial until T-403 supplies real achievements/passport and owner history;
T-403 must resolve disclosure of private-event stamps. No requirement is removed from v1.
**Why:** the souvenir engine includes final-rank lifecycle, category/all-quest audiences, tenant authorization and
batched grants, beyond a profile screen. Each boundary deserves its own plan and code review.
**Trade-offs:** more than one task completes the original T-402 requirement group; TASKS records every handoff.

## ADR-267 — Cosmetics are server-owned grants with separate public reads
**Status:** Proposed (worker recommendation, 2026-10-25; Q-231).
**Decision:** A data catalog and level-to-item map feed one idempotent grant per `level_reached` row through an AFTER
INSERT trigger, with a migration backfill. Own-only inventory and equipment use narrow definers, never direct API
writes; choosing a starter avatar clears the earned character slot. XP drops retain earned items. Erasure removes
owned/equipped items under the documented XP/grant lock order. The public profile uses a separate allowlisted DTO,
never `readMe`, and is available by current username to active signed-in players with no shared-event requirement.
Public target resolution excludes deleted and platform-banned players; no contacts, XP, locker provenance or event
history is returned. Equipment edits and a simultaneous username change are atomic.
**Why:** SQL grants must cover every XP writer; ownership cannot rely on client choices; FR-702 permits a narrow
Questify-wide public identity while event history and account data remain private.
**Trade-offs:** stale username links return 404 after a rename. A missing level mapping fails the XP transaction;
future curve administration must add complete reward mappings atomically. No anonymous public profile or directory.
**Upgrade safety (plan review, 2026-10-25):** migration first drains old erasures with player EXCLUSIVE, then takes
player_xp and level_reached SHARE ROW EXCLUSIVE, in that order, before creating FKs/replacing cleanup/backfilling.
This closes the old-function in-flight erasure race; two actual pre-upgrade connection schedules are required tests.

## ADR-268 — A deterministic shipped level-reward catalog
**Status:** Proposed (worker recommendation, 2026-10-25; Q-232).
**Decision:** Seed one distinct item at each level 2–30: a treasure-chest character at level 4 (existing shipped
chest art), frames at other even levels, cosmetic titles at odd levels. Use 14 finite shipped frame designs and
14 bounded bilingual titles. Six starter avatars stay freely selectable. The catalog's names and level mapping are
data; visuals select only shipped allowlisted renderers. Distinguish equipped titles from automatic level titles.
**Why:** every level immediately has an actual guaranteed reward, including previous reached rows, without a new
art upload/storage service or dependency. Existing art and native frame primitives fit the adventure theme.
**Trade-offs:** this is a recommended starting catalog, pending Dhia's taste review. New visual mechanics need an app
release; T-709 edits names/mappings only within ownership/grant invariants. No random item selection or duplicates.

## ADR-269 — Explicit, frozen organizer souvenir promises
**Status:** Proposed (worker recommendation, 2026-10-25; Q-233).
**Decision:** An owner/editor prepares a bilingual frame/title/character rule using shipped visual renderers, then
explicitly activates its permanent promise. Each rule has a distinct opaque item; activation freezes public cosmetic
content, audience and nonempty eligible quest targets. Joined means an approved active real enrollment, not proof of
physical presence. Finisher souvenirs count completed targets once across all periods, including existing quiz/game
terminal-done semantics, without daily re-awards. Later quest edits do not rewrite the target set. Stopping prevents
future grants and retains earned items; replacements require a new item/rule. No remote artwork or arbitrary player
list. Rank rules freeze before owner confirmation. At most100 rules per event, with1–100 rank bounds.
**Why:** Organizer promises must survive asynchronous work, category resets and live builder changes predictably.
**Trade-offs:** Later additions need a new explicit promise; recurring finisher progress is lifetime for the souvenir.
These recommended semantics require Dhia's review and are not Accepted by this planning commit.

## ADR-270 — Souvenirs extend owned items through durable scoped grants
**Status:** Proposed (worker recommendation, 2026-10-25; Q-234).
**Decision:** Extend0063's tagged ownership provenance with an event/rule receipt, keeping every level constraint and
public item DTO. Deny-by-default rules, targets, receipts and durable work have only narrow authorized SQL doors.
Fact triggers enqueue real recipients; bounded automatic workers evaluate relational eligibility and grant once.
Claim/ack transactions are separate from grant transactions, with generation fencing and leases; queues never hold
locks while waiting for player/enrollment/XP. Grants lock active player FOR SHARE (not KEY SHARE, which permits
an admin's concurrent non-key ban UPDATE), enrollment, frozen rule, then XP; the player lock lasts through commit. Erasure
removes equipment/items/receipts/work and cannot be followed by a tombstone grant. Source event names/IDs appear only
in the owner's locker, never public profile/ranking/equipment. Organizers do not gain an arbitrary-player grant door;
admin context cannot impersonate the empty-context system worker. Retry/repair is durable, no new queue service.
**Why:** Reuse existing equipping/privacy while separating play latency from lifetime grants and preserving erasure.
**Trade-offs:** Eventual automatic delivery with visible pending status; more DB work-state tests, no immediate scan
celebration promised. Source attribution survives leaving and archive for the earned item's owner.

## ADR-271 — Souvenir rank awards use owner-confirmed snapshots
**Status:** Proposed (worker recommendation, 2026-10-25; Q-235).
**Decision:** Extend result_depth through the highest active souvenir rank, capped100, independently of physical-prize
enablement. Existing preview/expected-place confirmation includes that depth; preserve community payout and quiz
settlement barriers. Grant only frozen result_place recipients after owner confirmation; never live/cache ranks or
automatic confirmation. Rank activation after confirmation is refused rather than fabricating missing historical
places. A late ineligible recipient is skipped without promoting another rank; earned items remain permanent.
**Why:** Existing snapshots may retain only10 places; retroactive live ranking would contradict confirmed results.
**Trade-offs:** The owner still confirms after event end. Pre-confirmation rules are required for rank souvenirs;
historical confirmed events cannot add a new rank promise through this feature.

## ADR-272 — Souvenir repair passes are finite; fact triggers carry every later change
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-402b review repair; Q-236). Replaces the plan's periodic
repair sweep and 0064's "repeat completed scans every minute"; ADR-270 otherwise stands.
**Decision:** A souvenir_scan row is one finite pass: a non-rank activation or an owner/editor Process request starts
it, it queues 500 real members per batch behind a cursor, waits until the event is live (one-way, 0009's times guard),
and deletes itself at the end. A rank rule starts no activation pass; its result_place trigger queues the confirmed
places, and a Process pass for it reads only placed members in range. After a pass, triggers on every fact the evaluator
reads queue the member: enrollment join/approval/event unban, quest completion, finished quiz, terminal game round (the
lifecycle tick's expiry included), result_place, an operator allowed to play or removed, and a platform account
reinstated. A re-enqueue keeps the earlier ready_at. The evaluator pre-checks without locks and returns before the
player/enrollment/XP locks when no missing active souvenir qualifies; the locked path rechecks everything in ADR-270's
order. A worker releases the claims its time budget left unevaluated.
**Why:** The repeating sweep re-queued every non-recipient of a rank or category rule each minute for the event's life,
kept the dashboard pending, logged souvenir.pending every tick, delayed live work and took write-contending locks
beside quest scans. The 20k benchmark used a joined rule, which everyone leaves, so it could not show this.
**Trade-offs:** A change made outside these facts (an owner-connection data repair, a future qualification source
without its trigger) is picked up only by a Process request; DATA_MODEL lists the triggers a new source must extend.

## ADR-273 — T-403 splits into a core server task, a core Questify-quests task and a standard surfaces task
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-403 plan; Q-239).
**Decision:** T-403 (CORE): event city, final-rank snapshot, Event Passport and owner history reads, achievement tiers,
the `questify_sync` evaluator and the public profile's achievements/passport. T-403b (CORE): always-on and seasonal
Questify quests, console API doors, XP awards through `xp_entry`. T-403c (STANDARD): app, dashboard and console screens
and all copy. One plan (`docs/plans/2026-10-26-t-403-achievements.md`) and one plan review cover all three (review
88, amendments folded). T-403c gets one standard code review that includes the Arabic pass (no separate Arabic run);
one `mutation.yml` dispatch covers T-403 and T-403b.
**Why:** A new evaluator, a confirm-results change, admin powers, a new XP source and three surfaces are more than one
worker can build and prove in one run; splitting by risk lets the display work use a cheaper model and a lighter review.
**Trade-offs:** Three code reviews instead of one; T-403's "Done when" is shown on screen only when T-403c lands.

## ADR-274 — Achievements and the passport derive from standing XP credits through one sync evaluator
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-403 plan; Q-241).
**Decision:** A player played an event when they hold a non-reversed quest XP credit there on an enrollment that passes
the one shared `played_enrollment` predicate (not rehearsal, banned or removed); all five metrics use that predicate. The
Event Passport is computed on read from those credits. Achievement tiers (and T-403b's Questify awards) are append-only
rows written only by `questify_sync()`, which the app calls on Profile/Questify focus, on foreground and after
completions (debounced about 15 s, a 429 handled silently). It first checks, without locks, whether anything new is due
(the ADR-272 pattern) and answers at once when nothing is; otherwise it locks player (KEY SHARE) then `player_xp`,
computes the metrics again and inserts with unique keys. Earned rows are never taken back. Nothing is added to the
completion transaction.
**Why:** Every fact already exists on the server, so nothing can be forged; unique keys make replays and races grant once;
the scan path keeps its latency and lock set. Materialized rows give T-404 something to pay gems on, once per row.
**Trade-offs:** A tier earned through top-10 or community goals appears at the player's next sync, so another player may
briefly see an older tier; a removal that drops a count below a threshold leaves the tier.

## ADR-275 — The passport's final rank is a confirm-time snapshot shown after the reveal
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-403 plan; Q-242).
**Decision:** `confirm_results` also writes `final_rank` for every ranked enrollment, in one data-modifying statement
with `result_place` that reads the ordering (`all_places`) once. A stamp shows the rank once results are revealed; before that it says the results are not final, and a
member with no row is "not ranked". Already confirmed events are backfilled from `result_place`, then the rest in order, under a bounded `event_result`
lock.
**Why:** `result_place` stops at the results depth (at least 10), but FR-709 shows every player's final rank; scores are
frozen at confirmation, so the snapshot is exact and stable. The reveal keeps the organizer's ceremony.
**Trade-offs:** One insert per ranked member at confirmation; an event whose results are never confirmed shows no rank.

## ADR-276 — The public passport lists only ended public events
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-403 plan; Q-243; amended by the plan review's MAJOR-1 and
MINOR-5). Resolves T-402's open point.
**Decision:** Another player sees up to 50 newest stamps of played events that, at read time, are `public`, are not
workplace events, and have ended or been archived; never while the event is live. Each stamp shows name, local date,
city and final rank only. Unlisted, private and workplace events, the owner's history, scores, join answers, progress and
any count of hidden stamps never enter the public DTO. The owner's own view lists every played event, each marked
whether it is public now. Achievement tiers count every played event.
**Why:** Attending a private or workplace event can reveal an employer or affiliation; a live stamp would let anyone
polling a username learn where that player is now; a tier shows a number, not an event.
**Trade-offs:** A player cannot choose to show a private event publicly; a public stamp appears only after the event ends.

## ADR-277 — Events gain a city from a seeded catalog
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-403 plan; Q-244).
**Decision:** A `city` table (about 20 Saudi cities, bilingual, ordered; no `active` flag until the console edits it)
and `event.city_id`, set by the owner or an editor, none for virtual events, frozen by its own trigger once the event is
live, ended or archived. "Cities played" counts distinct cities of played
events; events without a city count none. T-407 reuses the table for the player's city.
**Why:** FR-707 and FR-710 count cities, and no event carries one; free-text venues cannot be counted.
**Trade-offs:** Older events count no city; until the console can edit the list (T-703/T-709), a new city needs a migration.

## ADR-278 — Questify quests are console data with a closed metric list, paid in XP
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-403 plan; Q-245).
**Decision:** The Questify team creates always-on quests and seasonal campaigns (window entered in Saudi time) in the
console; metrics are events, cities and quests played. A campaign is published only before it starts. Seasonal quests
count only facts inside their window (on the ledger entry's time) and are offered only inside it; a sync up to 3 days
after the end still pays a qualifying in-window play. A quest's metric, target and campaign freeze once it can pay
(active always-on, or campaign published); the caps are a count check in the admin save. A met quest writes one
`questify_award` and one `xp_entry` (new source `questify`) through T-401's `xp_apply`, so levels and level items follow.
A Questify quest shows its XP reward. No event points, gems, items, money or trading. "Follow Questify" is not built.
**Why:** Configuration over code without downloading features; one XP path; an out-of-app follow rewarded with XP may
conflict with App Store 3.2.2(x), and FR-710's other examples meet the requirement.
**Trade-offs:** A veteran who already qualifies for a new always-on quest gets it at their next sync, not at once.

## ADR-279 — Seeded thresholds and rewards; no item or gem rewards before T-404
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-403 plan; Q-240).
**Decision:** Achievement tiers (bronze/silver/gold): events 1/5/15, quests 10/50/200, cities 2/4/8, top-10 finishes
1/3/10, community goals 1/5/15. Seeded always-on quests: attend 3 events and play in 2 cities, 300 XP each. Achievements
and Questify quests grant no item or gem yet; T-404 pays gems from the earned rows (ADR-046).
**Why:** Bronze within the first event or two keeps new players engaged; gold takes a season of play.
**Trade-offs:** ADR-046's achievement items wait for catalog art and T-404.

## ADR-280 — Questify quest console rules as built (T-403b)
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-403b build; Q-246). Extends ADR-278.
**Decision:** A quest's campaign is chosen when it is created and never moves. `active` is one-way: an active quest is
retired, never put back to draft. Nothing is deleted: a draft quest or campaign is retired (no delete door). A quest
cannot be added to, or edited in, a retired or ended campaign; retire still works. A published campaign that
has started takes no new quest (`started`: it would count plays back to the start; code review MINOR-2). A
published campaign's start moves
only before it starts and never into the past; once started the start is fixed and the end only moves later; once
ended the window is fixed (the name still changes). Publishing an already published campaign answers it as it is.
The caps count quests not retired (drafts included): 20 per campaign, 50 always-on. The console list shows every
always-on quest and the 100 latest-starting campaigns and is not audited (no personal data). A sync's `levelUp` has
the completion answer's shape (level, title, the level items those payments gave). The two seeded always-on quests
are active from the deploy, so a veteran who already qualifies is paid at the next sync. Console refusals answer
`409 questify_conflict {reason}` or `422 invalid_questify {field}`; the console (T-403c) words each reason.
**Why:** Fixed conditions and no deletion keep every award explainable; one rule per state keeps the doors small.
**Trade-offs:** A mistyped quest in the wrong campaign is retired and made again; on the first sync after the deploy
veterans may be paid both seeded quests and reach a level at once.

## ADR-281 — T-403c screens as built: one sync scheduler, ids-only public badges, no points on the history
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; built and CTO-reviewed; was a worker recommendation, 2026-10-26, T-403c build; Q-247). Extends ADR-273 to ADR-280.
**Decision:** The app syncs through one scheduler: on focus of Profile or the Questify quests, at launch and sign-in,
on each return to the foreground at least 5 minutes after the last call, and 15 seconds after the last first-time
completion (a trailing debounce; every completion flow ends in `completionAnswer`, which signals it). Calls never
overlap, and a 429 pauses syncing for its Retry-After (60 seconds when it names none) and shows nothing. A sync that
writes shows light toasts, the level-up card when `levelUp` is set (Reduce Motion respected), and makes the profile and
Questify screens read again. Achievements show the shipped badges in a ring in the tier's colour (three theme tokens)
and a dark silhouette with a padlock when unearned; progress to the next tier is on your own profile only. The public
profile sends ids and tiers, so another player's badges take names and art from the viewer's own catalog, and the
passport is shown as sent. The Event Passport is on the profile; the history is its own screen and shows no points (the
currency's word is per event and not in the answer). A draft or scheduled membership reads "Upcoming", a running one
"Live now". The dashboard's city picker is hidden for an online event and read-only from live; the console page enters
times in Saudi time, retires instead of deleting after a confirmation, and words each refusal by reason and field.
"Ends in N days" counts Saudi calendar days with Arabic's one, two, few and many forms. Strings follow ADR-125 (Latin
"Questify") and call a campaign "موسم" as the API's own messages do.
**Why:** One scheduler keeps the server's 20-a-minute limit safe and makes each trigger testable; the viewer's catalog
needs no API change; no new store or screen state is needed.
**Trade-offs:** The public profile needs a second read for badge names; a history row cannot show its points; the
scheduler sits behind a signal in the completion parser, which is a side effect in a parser.

## ADR-282 — Accept the two Expo CLI dependency alerts (zod 3, node-forge) until upstream fixes
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27).
**Decision:** Dependabot alerts #7 (zod 3.25.76, GHSA "oversized constrained collections", fixed only in zod 4.6.6) and
#5 (node-forge 1.4.0, GHSA-86w9-cpqp-85rv, RSA PKCS#1 v1.5 signature parsing, no fixed release) are dismissed as
tolerable risk. Both arrive only through `@expo/cli` 57, the developer and EAS build tool: neither is in the app bundle
nor in the API image, and neither handles player or untrusted input there (the CLI validates its own config and makes
a local dev certificate). The latest `@expo/cli` (57.0.32) still requires `zod ^3.25.76`, and forcing zod 4 on it with
an override would break the CLI. Our own code uses zod 4.6.7.
**Why:** No fix is available that does not break the build tool, and the vulnerable code cannot be reached by an outsider.
**Trade-offs:** The alerts stay dismissed until reopened; the monthly Dependabot run and `pnpm audit` keep watching, and
the next Expo SDK upgrade must recheck both.

## ADR-283 — Publishing a Questify campaign asks for confirmation first
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; answers Q-248).
**Decision:** The console's Publish button opens a confirmation dialog, built like the retire dialog, saying that
publishing cannot be undone and starts paying XP to players. Only the dialog's confirm button sends the publish call.
**Why:** Publishing is one-way and affects real players; the retire action already confirms.
**Trade-offs:** One extra click per publish.

## ADR-284 — T-404 split: the gem ledger and shop (core), then the screens (standard)
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 88 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-404 plan; Q-249).
**Decision:** T-404 (CORE) builds migration 0067, the API doors and the shared schemas: the gem ledger, the payments in
`questify_sync`, the gem shop and its purchase door, quest `gems` on the console doors. T-404b (STANDARD) builds the
app's gem count and gem shop screen, the "+N gems" toast line, gems on the Questify quests list, the console quest
form's Gems field, the new frame designs and every string. One plan (`docs/plans/2026-10-27-t-404-gems.md`) covers both.
**Why:** The T-403 precedent: the spend door and the ledger get the strongest model and a core review; display work
goes to the cheaper model and a standard review.
**Trade-offs:** Two workers and two code reviews; FR-725's on-screen Givens are proven only by T-404b.

## ADR-285 — The gem ledger: append-only, closed sources, balance on `player_xp`
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 88 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-404 plan; Q-250). Extends ADR-046.
**Decision:** `gem_entry` is append-only and kept on the erasure tombstone, like `xp_entry`. Its source list is closed:
`level`, `achievement`, `questify` (credits) and `purchase` (a spend), each bound by a composite foreign key to the
same player's source row and unique per source row. There is no transfer, gift, adjustment or expiry source. The
balance is `player_xp.gems` with `CHECK (gems >= 0)`, the row every sync and purchase already locks. Gems are never
shown to other players.
**Why:** A closed list makes "earned only from Questify activity" (FR-724) and "no trading" (FR-725) structural, so a
later task cannot add a gem source without a migration a review sees; one locked row adds no new lock order.
**Trade-offs:** `player_xp` holds two caches; an admin correction or a fraud revoke needs a new source and migration.

## ADR-286 — Gems are paid by the sync, once per earned row, retroactively; amounts are data
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 88 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-404 plan; Q-251). Extends ADR-274, ADR-280.
**Decision:** `questify_sync()` is the only door that credits gems. Under its existing locks it pays every
`level_reached` row (level 2 and up), `achievement_earned` row and `questify_award` row (quest `gems` above 0) of the
caller that has no gem entry yet; nothing is added to the completion transaction. Rows earned before T-404 are paid
at the first sync after the deploy. Amounts: `platform_setting` key `gems` `{levelUp: 20, bronze: 10, silver: 25,
gold: 50}` (each field used only when an integer 1–1000, otherwise its fallback in `gem_amounts()`; 0067 writes no row
and no CHECK, T-709 adds both with the editor, so the migration never locks `platform_setting`, plan review MAJOR-1) and `questify_quest.gems` (0–1000, frozen once the quest can pay; the two
seeded quests 25). A changed setting applies to rows paid later.
**Why:** One evaluator keeps the scan path's latency and locks unchanged; paying per row makes replays and concurrent
syncs harmless; retroactive pay keeps veterans level with newcomers.
**Trade-offs:** Level-up gems arrive at the next sync (about 15 s after the scan), not with the level-up card; a quest's
gem reward cannot be raised after launch (retire it and make a new quest).

## ADR-287 — The gem shop: exclusive seeded items, one copy each, a checked purchase
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 88 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-404 plan; Q-252). Extends ADR-046, ADR-002.
**Decision:** `gem_shop_item` lists items for sale at a fixed gem price (active or retired); an item sold in the shop is
never a level reward or a souvenir (a guard refuses both directions). A player owns at most one copy. `gem_buy` takes
the item, the price the player saw and an idempotency key; it refuses an unknown or retired item, an owned item, a
changed price and too few gems (nothing written), and replays a repeated key with the current balance (the route's
replay store also replays a refusal, so the app makes a fresh key per confirmation). A shop item's catalog entry is
frozen and its source-map writes serialize on the item, as an active souvenir's. A purchase writes one purchase row, one
negative gem entry and one locker item (`source = 'shop'`); XP is never touched. Retired items stay owned and
equippable. The catalog is seeded; console editing waits for T-709 (FR-1403).
**Why:** Exclusive sources keep `player_item`'s one row per item safe from a later level grant; the seen price stops a
silent charge after a price change; the key makes a retried tap safe.
**Trade-offs:** Changing prices or adding items needs a migration until T-709.

## ADR-288 — Seeded shop catalog: six frames and six titles, no characters yet
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 88 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-404 plan; Q-253).
**Decision:** Six frames on six new procedural frame designs (`frame-15` to `frame-20`, rendered by `frameDesign`) and six
titles, adventure-themed in both languages; titles cost 40 to 80 gems, frames 80 to 150. No character is sold until new
character art exists, so FR-726 is partial for characters.
**Why:** All fourteen existing frame designs are level rewards, and a shop frame that looks like a level frame would
confuse players; new procedural designs need no art run. One event (about 15 quests) earns about 100 gems, so a first
item is within reach after one event and the whole catalog takes a season.
**Trade-offs:** No characters in the shop at launch; prices are a first guess to revisit with real play data.

## ADR-289 — Gem shop wording and the store-compliance row
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 88 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-404 plan; Q-254).
**Decision:** The shop's action reads "Get" (احصل عليه), never "Buy". The app has no "add gems" or "get more" control
and no link out; a player short of gems is told how gems are earned. The shop shows "Gems are earned by playing. They
can't be bought." STORE_COMPLIANCE 1.6 gains the row: gems earned by play, spent on cosmetic items, no IAP needed,
nothing sold, no trading. No random grant or mystery item.
**Why:** Apple 3.1.1 applies to items sold; the wording and the absence of any purchase control keep a reviewer from
reading the shop as an unpaid in-app purchase; no chance keeps the age rating unchanged.
**Trade-offs:** "Get" is less familiar than "Buy" for a shop.

## ADR-290 — T-404 build choices: the purchase key, the quest gems field, the locker's shop source, the profile balance
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; CTO code review GO 93; Q-255). Extends ADR-286, ADR-287.
**Decision:** (1) `POST /v1/me/gem-shop/purchases` needs a UUID Idempotency-Key (400 `idempotency_key_invalid`
otherwise): the database keeps it with the purchase as `gem_purchase.request_key uuid` (the plan's type), and the app
already makes UUID keys. (2) The console quest body's `gems` is optional: left out, a new quest pays none and a saved
quest keeps its value, so the console keeps saving quests until T-404b adds the field; a value is checked by
`questify_gems_of` (`422 invalid_questify {field: gems}`) and frozen with the metric and target once the quest can pay.
(3) The locker names a shop item's origin: `own_locker` is re-created with a `source` column and the locker answer
gains `source: {kind: "shop"}` (the app shows no line for it until T-404b's string). (4) `GET /v1/me` reads the balance
through a new caller-bound `own_gems()` and answers it as a top-level `gems`. (5) A `GS409` refusal carries the reason
in DETAIL and the caller's balance in HINT, which the API answers as `409 gem_shop_conflict {reason, gems}`. (6) The
seeded catalog ids and names: titles `shop-map-reader` قارئ الخرائط / Map reader 40, `shop-dune-watcher` راصد الكثبان /
Dune watcher 50, `shop-oasis-warden` حارس الواحة / Oasis warden 55, `shop-pearl-diver` غوّاص اللؤلؤ / Pearl diver 60,
`shop-desert-knight` فارس الصحراء / Desert knight 70, `shop-star-navigator` ملّاح النجوم / Star navigator 80; frames
`shop-dune-ring` حلقة الكثبان / Dune ring 80 (`frame-15`), `shop-compass-ring` حلقة البوصلة / Compass ring 90
(`frame-16`), `shop-falcon-ring` حلقة الصقر / Falcon ring 110 (`frame-17`), `shop-desert-ring` حلقة الصحراء / Desert ring
120 (`frame-18`), `shop-pearl-ring` حلقة اللؤلؤ / Pearl ring 135 (`frame-19`), `shop-moon-ring` حلقة القمر / Moon ring 150
(`frame-20`). Shop frames are "rings" (حلقة) so none reads like a level frame (إطار …).
**Why:** Each keeps the plan's shapes while letting the console and the app run unchanged until T-404b.
**Trade-offs:** A purchase key is narrower than the other doors' (any visible ASCII); an optional field means a console
that forgets it keeps the old value rather than failing.

## ADR-291 — 0067 keeps the plan's lock order; two deploy-time deadlock windows are accepted
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; CTO code review GO 93; Q-256). Extends ADR-286 (plan review MAJOR-1).
**Decision:** 0067 takes the plan's lock list in the plan's order (player, player_xp, level_reached, achievement_earned,
questify_quest, questify_award, item, player_item, level_item, souvenir_rule). Two live paths cannot fit any single
order: a sync whose unlocked pre-check read `questify_quest` and `questify_award` and then waits for the player lock,
while the migration holds the player and wants those two tables (a sync with an achievement tier due locks the player
first and reads them later, the opposite order); and a locker read that holds `player_item` and then reads `item`. If
either crosses the deploy at that moment, PostgreSQL aborts one side: the request answers 503 busy and is retried, or the
migration fails, rolls back whole and is run again. Nothing is half-written. A lock-with-retry loop in the migration
(locks taken in a subtransaction under a short `lock_timeout`, released and retried) would remove both windows; it is
not built now.
**Why:** The order fits every other live path (scans, erasures, the souvenir evaluator, purchases) and the windows need
a request at the exact deploy moment; CranL has no real players yet.
**Trade-offs:** A deploy under load can fail once and need a rerun; the retry in the migration runner (T-022, before
real players) removes the rerun.

## ADR-292 — T-404b: how the gem shop screen buys, asks again and equips
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; code review GO 91; was a worker recommendation, 2026-10-27, T-404b build; Q-257). Extends ADR-287, ADR-289, ADR-290.
**Decision:** The gem shop (`app/gem-shop.tsx`) opens from the Profile (beside the gem count) and from the locker. It
shows the balance, the line "Gems are earned by playing. They can't be bought." on every visit, and items in sections
(frames, titles) as cards: a frame on the player's own avatar, a title on a name plate, the price in gems, then "Get"
(احصل عليه) or "Owned". "Get" opens a sheet that asks "Get {name} for {gems}?"; only its Get button sends the purchase.
The app keeps one key per confirmation: the same key is sent again only after a lost answer, a 5xx or a 409
`request_in_progress` (the server stored nothing for it); every other answer, a 409 and a 429 included, ends the
confirmation and the next one takes a new key. `price_changed` keeps the sheet open, reads the shop again and asks again
at the new price (or says the item left the shop); `too_few_gems` closes the sheet and says how gems are earned
(levels, achievements, Questify quests) and nothing else; `owned` and a retired item refresh the shop. A bought item
offers "Equip now" through the existing `PATCH /v1/me` (`frameId` or `titleId`). One "You earned N gems" toast per sync
that paid, and a sync that only paid gems counts as written so the profile balance is read again. The Questify quests
list shows "+N gems" beside XP when a quest pays gems. The locker says "From the gem shop" for a shop item.
**Why:** The route's replay store keeps every answer below 500, so a key reused after a refusal would replay the refusal
for ever; keeping the key only while nothing was stored makes a lost answer safe and every new try fresh.
**Trade-offs:** A player who confirms the same item at the same price right after a lost answer reuses that key, which
is intended (a replay answers the original purchase). A 200 the app cannot read, and a failed read after a price
change, read the shop again; the latter keeps the sheet open with the load failure.

## ADR-293 — T-404b: gem counts in Arabic, the six rings' colours, the console Gems field
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; code review GO 91; was a worker recommendation, 2026-10-27, T-404b build; Q-258). Extends ADR-288, ADR-018.
**Decision:** (1) Gems are counted by one helper with its own message forms: English "1 gem" / "N gems"; Arabic
جوهرة واحدة, جوهرتان (subject: «لديك جوهرتان») or جوهرتين (after a verb or preposition), «N جواهر» for 3 to 10 (and 0),
«N جوهرة» for 11 and over; digits are Western with a thousands comma. Gems are Questify's own word, not an event's
renamed currency, so ADR-058's rule does not apply. (2) `frameDesign` draws `frame-15` to `frame-20` from an explicit
table (royal purple, teal, crimson, terracotta, mauve, midnight blue), none in the level frames' palette and each at
3:1 or more against the page background (tested); the theme has no gem or royal colour role, so the six colours live
beside the table. (3) The console quest form gets a Gems field (0 to 1000, new quests start at 0), disabled with a
line saying the gems are fixed once the quest can pay, as migration 0067 decides it (an active always-on quest, or any
quest of a published campaign, a draft one too; ADR-286); the list row shows the gems. Arabic counts take the nominative
pair (جوهرتان) as a subject or after a colon and the oblique (جوهرتين) after a verb or preposition; a quest's gems on
the quests list read «مكافأة: …».
**Why:** Gems are counted in every screen and toast, so one helper keeps the grammar right; the old formula would have
repeated colours the level frames already use.
**Trade-offs:** The six colours are a design guess until the brand deck owner reviews them on a phone.

## ADR-294 — T-405 split: the streak ledgers (core), then the screens (standard)
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-405 plan; Q-259).
**Decision:** T-405 (CORE) builds migration 0068, the API doors and the shared schemas: day records for both streaks,
the event streak bonus (a points-ledger kind), the daily streak milestones (an XP source) in `questify_sync`, the event
streak settings door, the reads and the platform switch. T-405b (STANDARD) builds the app's streak lines, the success
beat, the profile line, the sync toast, history labels, the dashboard's Streak panel and every string. One plan
(`docs/plans/2026-10-27-t-405-streaks.md`) covers both.
**Why:** The T-403/T-404 precedent: ledger work gets the strongest model and a core review; display work goes to the
cheaper model and a standard review.
**Trade-offs:** Two workers and two code reviews; the on-screen Givens of FR-417 and FR-420 are proven only by T-405b.

## ADR-295 — Event streak days: open event days, organizer closed days, recorded whether on or not
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-405 plan; Q-260). Extends ADR-083.
**Decision:** The event streak counts, per enrollment, consecutive open event days (FR-1714's day start, inside the
event window) with at least one quest completion. A day is closed when its weekday is one of the organizer's closed
weekdays (at most six) or its date is a closed date; a closed day neither counts nor breaks, and a completion on it
writes nothing. One row per enrollment and open day played (`event_streak_day`, with that day's length) is written by
a trigger on the quest ledger entry for every multi-day event, whether the streak is on or not. Closed days and weekdays
can change only for days that have not started: a closed date only before it starts, a closed weekday only before its
first occurrence in the event, so a day lost to an outage cannot be closed afterwards. A single-day event extended to
multi-day mid-event counts from the next completion. The row is written by a plain INSERT, never updated (append-only);
nothing is written when the enrollment already has a row for a later day (a transaction that began before the day
boundary). Plan review 2026-10-27: MAJOR-1, MINOR-5, MINOR-6.
**Why:** No closed-day data existed; weekdays plus dates cover a company season (weekends) and an event's holidays.
Recording always lets an organizer switch the streak on mid-event without a backfill that would race live completions,
and gives METRICS its return-visit data. Freezing started days keeps stored lengths and paid bonuses true.
**Trade-offs:** One small row per player and day on every multi-day event; an organizer who forgets to mark a past
closed day cannot fix it afterwards.

## ADR-296 — The event streak bonus: flat, from day 2, paid with the day's first quest
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-405 plan; Q-261). Extends ADR-045, FR-418, FR-1615.
**Decision:** The organizer sets the bonus (1 to 100,000 points) or none. It is paid by the system, once per enrollment
and open day, with the day's first quest completion through any door, when the streak that day is 2 or more; the same
amount every day. Its own ledger kind `streak`: never boosted, no XP, balance 0 while the shop is closed, counted by the
ranking, today's ranking and community points goals, removable on its own; removing it or the quest line never unpicks
the day. Paid by the `ledger_streak` trigger on the quest entry (before `ledger_xp`), so every door pays it and no payer
changes; the bonus entry is written first, then the day row carrying its id. Which day a completion counts for, and
manual awards: ADR-301.
**Why:** A first day is not yet a streak; a flat amount is predictable for the organizer and bounded; the trigger pattern
(T-401's `ledger_xp`) cannot miss a door.
**Trade-offs:** No growing reward for long streaks; a removal for cheating keeps the day counted (the team removes the
bonus line too).

## ADR-297 — The Questify daily streak: one Riyadh day, any quest completion, only while on, own-only
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-405 plan; Q-262). Extends ADR-045.
**Decision:** The Questify day runs 04:00 to 04:00 Asia/Riyadh for everyone (`questify_day`, reused by T-406). A day
counts when the player has any non-rehearsal quest completion in any event; T-406 adds the daily challenge and word
through the same row. The `ledger_streak` trigger writes one row per player and day, only while the platform switch
`dailyStreak` is on, so days while off never count and the streak restarts after it comes back. The length is read, not
stored. Only the player sees their daily streak.
**Why:** The daily word is the same for everyone that day, so the day must be one platform day; 04:00 matches the events'
default for late nights. Writing at completion is exact even for a player who never opens the app between kiosk scans;
the row has no foreign key so it adds no player lock to the scan path.
**Trade-offs:** Players outside Saudi time see the day change at another local hour; until T-406 a player without an
event has nothing that keeps the streak alive.

## ADR-298 — Daily streak rewards: XP at milestones, once ever, paid by the sync
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-405 plan; Q-263). Extends ADR-046, FR-421.
**Decision:** The daily streak pays XP only, at seeded milestones (3, 7, 14, 30, 60, 100, 200 and 365 days: 50 to 750
XP), each once ever per player, written by `questify_sync` as `xp_entry` source `streak` bound to a
`questify_streak_reward` row. No items yet. It never writes event points or gems: no ledger or gem source exists for it.
A level reached through streak XP pays its level-up gems and item like any level: FR-421's "gems unchanged" is read as
"the streak reward itself writes no gems" (agreed by the developer at the plan review, 2026-10-27).
**Why:** Once-ever milestones bound the XP and avoid "lose it and you lose the next reward" pressure; paying in the sync
keeps XP locks out of the scan path (ADR-274).
**Trade-offs:** A returning player is not rewarded again for a second 7-day run; the level-up gems a streak can trigger
are an indirect gem effect (Q-263).

## ADR-299 — Streak switches: a platform feature key and an owner-only event settings row
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-405 plan; Q-264).
**Decision:** The platform switch is `FEATURES.dailyStreak` (`level: "platform"`, on by default), shipped in `/v1/config`
and read in SQL by `daily_streak_on()`; T-703's switches page is its console control. The event streak's on/off, bonus
and closed days live in `event_streak`, set only by the event owner through `set_event_streak` (validated, audited), not
in `event.config.features`.
**Why:** Event config switches default on, are not checked in SQL and carry no amount; the bonus pays points, so it needs
a validated, audited door. The platform key reuses the existing registry and console.
**Trade-offs:** Until T-703 ships its page, the platform switch is flipped through the settings service only.

## ADR-300 — Streaks put no pressure on players
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-405 plan; Q-265). Extends ADR-083.
**Decision:** Nothing about a streak is sold or offered (no freeze, repair or restore). Copy never threatens a loss or
guilt-trips; no countdown to the day's end and no red badge; a broken streak reads "Start a new streak today"; a closed
event day says the streak is safe. T-501's streak reminders follow the same rule. STORE_COMPLIANCE §6 gains the row.
**Why:** Store review and the research (GAMIFICATION_PATTERNS: streak anxiety) favour encouragement over loss framing;
players are 13 and over.
**Trade-offs:** Softer copy may keep fewer streaks alive than loss-framed copy would.

## ADR-301 — Which day a streak completion counts for: the day it is paid; manual awards count
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a developer decision for v1 at the T-405 plan review, 2026-10-27; Q-266). Extends ADR-295, ADR-296.
**Decision:** A completion counts for the event day (and the Questify day) on which its quest ledger entry is written,
whatever the door: a submission a reviewer approves counts on the approval day, not the day it was sent; a quiz on its
finish; a game on its result. The team's manual quest award (`method = 'manual'`) is a completion like any other: it
counts the day and, as the day's first completion, pays the event streak bonus.
**Why:** The trigger on the quest entry is the one place every door passes, and the entry's time is the only time every
door has; a manual award is the team confirming a quest the player did.
**Trade-offs:** A player whose submission waits overnight for review may miss the day they actually played; a team can
keep a player's streak alive by hand (the organizer's own call).

## ADR-302 — T-405 build choices: the bonus moves the balance, the reads' shapes, the settings door's replay
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-405 build; Q-267). Extends ADR-295 to ADR-299, ADR-301.
**Decision:** (1) The streak bonus moves the balance with the score: the trigger pays only while the event is live, when
its shop is always open, so ADR-296's "balance 0 while the shop is closed" cannot arise and is not written; the shape
CHECK still allows a balance of 0 as the other system bonuses do. (2) The daily streak read is `{days, today, next}` with
`today` a boolean (today's Questify day is counted), `next` the first unpaid milestone above the length; the sync answer
adds the milestones it paid (`rewards`). The event streak read on Home is `{days, playedToday, closedToday,
bonusPoints}` or null while the streak is off, the event single-day or not live. (3) `set_event_streak` answers
`unchanged` and writes nothing (no audit row) when the settings are already these; with the route's Idempotency-Key
this is the door's replay. Final results reuse `RF409 results_final`; the other refusals are class `ST` (`ST409`
single_day, archived, day_started with the day; `ST422` with the field). (4) The milestone table is append-only like the
other three streak tables (a migration that edits it disables its trigger in the same change, until T-703/T-709 add an
editor). (5) The team's award list (`manual_awards`) shows a removed streak bonus under the paying quest's title, as it
does a removed first-N bonus; the member record and the player's history name it by kind and streak day.
**Why:** Each keeps the reviewed plan's rules while removing a branch no door can reach and fixing shapes the plan left
open.
**Trade-offs:** A later rule that pays a streak bonus after the event (none planned) would need the closed-shop branch
back.

## ADR-303 — The streak trigger's cost at the entrance burst: a burst budget, not a percentage
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; plan review 86 folded, code review GO 93; was a worker recommendation, 2026-10-27, T-405 build; Q-268; target changed at the code review). Extends ADR-296, ADR-297, NFR-002.
**Decision:** The streak work at the entrance burst is accepted within a budget of about 20 ms at p95, inside NFR-002's
1 s, in place of the plan's 10% target. Measured by hand (300 first-of-the-day completions at once from two pools of
10, median p95 of six rounds, against the same burst with no streak work: a single-day event, the daily switch off):
the worker's runs gave +24.2% (75.2 → 93.4 ms) and +12.0% (78.3 → 87.6 ms; day rows alone +13.8%); the CTO's rerun at
the code review gave 75.7 ms without streak work, 89.1 ms with the full streak work (+17.7%, about 13 ms) and 84.2 ms
with the day rows alone (+11.3%). Only the day's first completion pays this; later completions of the day cost one
primary-key probe. Every streak completion paid exactly one bonus. `apps/api/test/perf/streak-timing.int.test.ts` reruns
it; it is re-timed when T-406 writes the same daily row.
**Why:** The cost is two small inserts, one nested ledger entry (the T-313 first-N bonus measured +22.7% for one, Q-229)
and a few primary-key reads, all inside the transaction the payer already holds; moving any of it out of the
transaction would lose the exactness the plan needs (the day row and the bonus with the completion that earned them). A
percentage of a fast baseline penalises a small absolute cost; a budget in milliseconds within NFR-002 states what
players feel.
**Trade-offs:** A large entrance burst on a multi-day event with the streak on is about 10 to 20 ms slower at p95.

## ADR-304 — T-405b app copy and layout: days in a row, a closed day first, the redone flame, one line in every answer
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; code review GO 91; was a worker recommendation, T-405b build; Q-269). Extends ADR-300, ADR-302.
**Decision:** (1) The card's headline is "{N} days in a row" (Arabic «{N} أيام على التوالي», with the dual and the singular
noun from 11 days) in place of the plan's "Day {N}": the stored length stays true on a day the player has not played yet,
where "Day 3" would read as today. The success card keeps "Streak day {N}! +{points}". (2) The state is read in the order
closed today, played today, a live streak, a fresh start (T-405 code review note): a closed day says "The event is closed
today. Your streak is safe." (or only "The event is closed today." at 0) and never invites play. (3) The flame is the
redone `icon-flame` (upright, one connected shape, no sparks), reviewed at full size and shipped as
`apps/app/assets/icons/flame.png` at 128 px; it is decorative and the card is one element with a spoken label. (4) The
scan celebration gets a streak beat after the first-N beat and before the level beat; every other answer (quest sheet,
vote, survey, share, poll, game, quiz) carries the same line as its last sentence. (5) The profile shows the daily streak
as an unframed block beside the gems (like the level and the gems), with the next unpaid milestone; one sync toast per
milestone paid ("Streak of 7 days! +100 XP"). (6) The app hides the daily streak when `/v1/me` sends null (the server's
reading of the platform switch); it reads no second copy of the switch.
**Why:** Each keeps ADR-300's no-pressure rule (no countdown, no alert colour, no loss words; a unit test scans the
lines) while showing the streak where a player already looks.
**Trade-offs:** A phone that has not refreshed `/v1/me` keeps showing a daily streak for a short while after the switch
goes off; the next read hides it.

## ADR-305 — T-405b dashboard Day streak panel: one Save, upcoming dates only, the owner-only note on every event
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; code review GO 91; was a worker recommendation, T-405b build; Q-270). Extends ADR-299.
**Decision:** The panel sits on the event page after the other switches. Its five settings go to the server as one body
(`PUT …/streak` takes all or nothing), so it has one Save button with an Idempotency-Key per distinct body, not the
tick-to-save of the single switches. Closed weekdays are chips (at most six); closed dates may be added only for days
after the event's own today, and a date that has started is listed and fixed (the server refuses to change a started day,
and the panel words that refusal by reason: `day_started` names the day). A single-day event shows why it has no streak
instead of controls. An editor reads the state, the bonus and the closed days, and sees "Only the owner can change this."
on every event, single-day included (the organizers spec counts nine).
**Why:** A partial save would leave the weekday and date lists out of step with the bonus; the owner-only note on every
event keeps the editor's page the same shape whatever the event's length.
**Trade-offs:** A closed weekday that a started event day falls on is refused by the server, not pre-disabled by the
panel (the panel does not read the event's days).

## ADR-306 — T-406 split: the daily ledgers and doors (core), the app screens, the console pages
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406 CTO code review 94, about 96 after the fold-in; Q-272).
**Decision:** T-406 (CORE) builds migration 0069, the API doors and the shared schemas: the question and word banks,
the schedule by period, the cadence, the sponsor name, the plays and finishes, the XP source `daily`, the second writer
of the daily streak row and the two platform switches. T-406b (STANDARD) builds the app's challenge and word screens
and their entry cards; T-406c (STANDARD) builds the console's Daily and Word bank tabs, the cadence control and the
menu badge. One plan (`docs/plans/2026-10-27-t-406-daily.md`) covers all three.
**Why:** The T-404/T-405 precedent (ledger work gets the strongest model and a core review); the display half lands in
two different apps, each a full worker load.
**Trade-offs:** Three workers and three code reviews; the on-screen Givens are proven only by T-406b and T-406c.

## ADR-307 — Daily content periods: the Questify day, Sunday weeks, a cadence per kind from the next day
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406 CTO code review 94, about 96 after the fold-in; Q-273). Specifies ADR-099 and F-316.
**Decision:** A period is one Questify day (04:00 to 04:00 Riyadh, ADR-297) under the daily cadence, or Sunday to
Saturday under the weekly one. The daily challenge and the daily word each have their own cadence, kept as dated rows;
a change takes effect from the next Questify day (a second change the same day replaces it; asking for the cadence
already in force drops any pending change and answers "unchanged", so a running week never restarts), and a row whose
day has come can be neither written nor changed: a trigger checks the clock at write time (not at commit), and what
keeps a period consistent is the row lock, since the cadence door locks every cadence row of the kind FOR UPDATE and
reads the clock after that lock, while player doors hold today's governing row FOR KEY SHARE as they work out the
period. Both start weekly (ADR-099). After a change mid-week, the running week ends the day before (to daily)
or a short first week runs to Saturday (to weekly). Content is keyed by its period's first day; content left on a day
that is no longer a period start is never served and the console lists it as unused.
**Why:** One boundary for the streak and the games; the Saudi week; FR-1814's "from the next day" with no period ever
changing under a player mid-play.
**Trade-offs:** A cadence change can strand scheduled content until the team moves it.

## ADR-308 — Daily content: a two-language question bank, three questions a period, one word a language
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406 CTO code review 94, about 96 after the fold-in; Q-274). Specifies ADR-079 and ADR-097.
**Decision:** The team writes each question in Arabic and English with 2 to 4 options and one right answer. A period's
challenge is three bank questions (and an optional sponsor name); a question is used once ever. A period's word is one
five-letter word per language, each used once ever per language, and is always a valid guess. Content whose period has
started is frozen: every content door locks its row FOR UPDATE (a question save locks its challenge first) and then
checks the clock, a trigger refuses changes for every role, and a player's answer names the question (a replaced word
gets a new id), so content replaced just before 04:00 is caught as "changed". Content stranded by a cadence change can
be cleared while it has no plays. The console warns when the challenge covers fewer than 7 days or fewer than 2 periods ahead (today's period included), and
when a word language covers fewer than 2 periods.
**Why:** FR-730, FR-1733, FR-1811 and FR-1814; frozen content means no two players ever see different content for one
period.
**Trade-offs:** Under the weekly cadence the challenge warning asks for two weeks of questions (six questions).

## ADR-309 — Daily rewards: fixed XP paid at the finish, never points or gems; a finished play keeps the streak
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406 CTO code review 94, about 96 after the fold-in; Q-275). Extends ADR-297.
**Decision:** Each answer is final and the three are answered in order; finishing the challenge pays 20 XP plus 10 per
right answer (20 to 50). The word pays 50 XP when solved, none when not. The amounts are `platform_setting` data (the
`xp` block, falling back per field), within ranges that keep any payout at most 1000 XP: finishing 0–400, each right
answer 0–200, the word 0–1000. XP is written as `xp_entry` source `daily`, once per play, by the door that
finishes it, under the player's `player_xp` lock taken after the daily streak row; a level crossed pays its gems at the
next `questify_sync`. No points and no gems are ever written. A finished play (the third answer; the solving or sixth
guess) writes the daily streak row while the platform switch is on. A retry is recognized by its natural key
(position and choice, attempt and guess), so no Idempotency-Key is needed.
**Why:** FR-730 promises XP for answering, FR-1810 none for a lost word; paying at once lets the answer show the XP and
the level; the lock order matches the completion trigger's, so no deadlock with event play.
**Trade-offs:** A player who knows nothing still earns 20 XP a period; the streak can be kept by a word not solved.

## ADR-310 — The daily word's rules: five letters, Arabic folding, list-only guesses, one language a period
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406 CTO code review 94, about 96 after the fold-in; Q-276). Specifies ADR-097.
**Decision:** Words have five letters in both languages. Arabic input drops diacritics and the tatweel and folds أ إ آ ٱ
to ا; the alphabet is an explicit set of 33 letters (the 28 letters plus ة, ى, ء, ؤ and ئ, each its own key), the same
list in the database and in the shared package, tested to match. The word keeps its written form (hamza included) for
the reveal. A guess must be in the language's guess list or be
the period's word; a refused guess (length, letters, not a word) uses no try. Marks are right place, elsewhere (only
while an unmatched copy of the letter remains) or absent. A player plays one word a period, in the language of their
first guess. The word is sent only once the game is over.
**Why:** The usual word-game rules that players know; the folding removes spelling traps that are not about the word.
**Trade-offs:** Five letters limits the Arabic word choice; folding the alef forms merges words that differ only by
hamza.

## ADR-311 — A sponsored daily challenge: a disclosed name, nothing else
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406 CTO code review 94, about 96 after the fold-in; Q-277). Applies ADR-067 and PD-27.
**Decision:** The team may put a sponsor's name (Arabic and English) on one period's challenge; the app shows "Presented
by {name}" / "برعاية {name}" on it. No logo until a Questify bucket exists (Q-149), no link out, no tracking, no sponsor
login and no player data to the sponsor; the console shows Questify finish counts per period only. The questions stay
editorial, written by the Questify team. The sponsor deal is a contract outside the app. No prize is attached to a
daily challenge.
**Why:** FR-732 needs the sponsor shown; Google Play's ads help treats a disclosed paid placement apart from ads, while
sponsored native content counts as an ad, so the editorial rule keeps the "No ads" declaration (PD-27) true; no prize
keeps the games out of contest and competition-licence rules.
**Trade-offs:** No logo in v1 of the feature; the commercial terms (Q-279) and the disclosure wording (Q-280) are open.

## ADR-312 — Platform switches for the daily challenge and the daily word
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406 CTO code review 94, about 96 after the fold-in; Q-278). Extends ADR-299.
**Decision:** Registry keys `dailyChallenge` and `dailyWord` (platform level, on by default), shipped in `/v1/config`
and read by SQL the way `daily_streak_on()` reads `dailyStreak`. Off: that game is hidden and its doors refuse at once.
The daily streak switch is separate: with it off the games still pay XP but count no streak day.
**Why:** Configuration over code: Questify can stop either game without a release (content problems, a store question).
**Trade-offs:** Two more switches on T-703's page.

## ADR-313 — T-406 build choices: plain admin ids, `changed` for an unknown challenge, the three-question rule at commit
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406 CTO code review 94, about 96 after the fold-in; Q-282). Specifies ADR-307 to ADR-310.
**Decision:** (1) `set_by` and `created_by` on the daily tables are plain ids with no foreign key to `staff_user`, so
migration 0069 locks only `xp_entry`, `player` and `player_xp`; the audit log names the admin of every write. (2) An
unknown challenge id answers `changed` and a known challenge of another period `period_over`, as for words (the
re-review's rule); `GET /v1/me/daily` carries each question's `id` (the answer names it) and both move replies carry
`replayed`. (3) Console refusals: a retired question in a challenge is 409 `retired` and an unknown one 422 `questions`
(the position in `details.position`); a question save whose challenge changed between its read and its locks is 409
`changed`; a day that does not start a period is 422 `invalid_daily {field: not_period_start}`; a unique violation
is answered by its constraint: two first saves of one new day (`daily_challenge_starts_on_key`,
`daily_word_language_starts_on_key`) answer 409 `changed`, one word saved for two days at once
(`daily_word_language_word_key`) 409 `used`, and any other unique violation is a server fault (500). (4) A challenge holds exactly three questions
at commit (a deferred constraint trigger, a definer because it fires at COMMIT outside the door). (5) Coverage counts up
to 60 periods ahead; the guess list is read 100 words a page by page number; no words or questions are seeded (they
arrive through the console once Q-281 is settled). (6) The daily routes register beside the Questify player routes. (7)
The DB suites move the clock by replacing `questify_day` in their throwaway database with a copy that adds a shift
(`test_clock`); production SQL holds no test hook. (8) Only the cost the streak causes counts against ADR-303's burst
budget. The re-timed entrance burst (`test/perf/streak-timing.int`, median p95 of six rounds, two runs) put the streak
work at +15.4 and +20.3 ms over the plain burst: at the 20 ms edge. The shared-row collision (300 daily finishes of the
same players at once, +10.6 ms over 300 finishes of other players; about 26 to 31 ms in all) is an artificial stress
figure, not a launch pattern; the +62 ms that 300 extra concurrent transactions add is general load, judged under
NFR-002's 1 s (142 ms p95 in all, on the worker's machine). The CranL staging load test must include the `daily` kind,
and the burst is re-timed whenever a new writer of `questify_streak_day` is added.
**Why:** The plan's lock list and its no-leak rules; one meaning for `changed` across both games; content that is
always complete for the coverage count and the reads; tests that can cross 04:00 without waiting for it; the extra
finishes are new work at the same instant, not streak cost, and a laptop is not CranL.
**Trade-offs:** A deleted staff account leaves its id on the rows it set (as the audit log does); a racing first save
answers a retry-worthy 409 instead of waiting.

## ADR-314 — T-406b build choices: the games' screens, the keyboard, the marks and the next-date line
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406b code review 91, about 95 after the fold-in; Q-283). Specifies ADR-309, ADR-310 and ADR-300 on screen.
**Decision:** (1) Until Questify Home (T-408) the two games are two cards under "Daily games" at the top of the Profile's
Questify section, read from `GET /v1/me/daily`; a game that is `null` (switched off or no content) shows no card, and a
failed read shows none (the games' own screens say "could not load" with a retry). The cards promise no XP amount before
a finish (amounts are data, ADR-309); the XP shows once earned. (2) Each game is its own screen (`/daily-challenge`,
`/daily-word`), read again on every focus and after each move. (3) The challenge shows one question at a time; an answer
is final and is followed by a reveal (the right option marked by colour, a tick and a label; a wrong choice by a dashed
border, a cross and a label) that stays until the player taps Next or See result. (4) The word's grid and keyboard
follow the word's language, not the app's (an Arabic word fills right to left in an English app); tiles hold one letter
each, so Arabic shows isolated forms; the keyboard is the app's own, with all 33 Arabic keys (4 rows) or 26 English keys,
and a key shows the best mark its letter earned. (5) Marks use colour, a corner glyph (tick, ring, cross) and the border
style, with a legend; every tile reads "ب, right place" to a screen reader. (6) A refused guess (length, letters, not in
the list) keeps the typed letters and uses no try; a conflict reads the games again; a lost reply keeps the screen as it is
and the same move can be sent again (the natural keys make it safe). (7) A finishing move reloads the profile (XP, level,
streak), runs a sync (level gems, streak milestones) and shows the level-up card through the sync provider (`celebrate`),
because the sync does not report a level the door already paid. (8) "When the next one comes" is a date, never a timer:
"tomorrow", else "on {weekday}", or "next {weekday}" when that is today's weekday; it is worked out from the phone's clock
as a Questify day (Riyadh UTC+3, day starting 04:00) and reuses the weekday names of the streak settings. (9) The
revealed word is wrapped in a direction isolate so an Arabic word in an English sentence (or the reverse) keeps its
order. (10) A game's state is held on the server only; nothing is stored on the phone. Review fold-in: a failed read shows the
full-screen error only when no game is held, otherwise a banner above the game; the level-up card waits for Next or See
result (challenge) or a second after the result card (word); the Arabic keyboard has rows of 9, 9, 9 and 6 keys at one
width and Enter and Delete on their own row; a lost connection says what is kept, per game.
**Why:** The plan's surfaces with the accessibility rules of the task (marks never by colour alone, screen-reader labels,
RTL, Reduce Motion through `PopIn`); the same patterns as the gem shop (pure flow functions, one reader per screen).
**Trade-offs:** The next-date line trusts the phone's clock (display only; the server decides what counts), and says
"tomorrow" even when the next period has no content yet; the cards vanish on a failed read; no hardware keyboard support.

## ADR-315 — T-406c build choices: the Content page, the period control, "Remove" for stranded content and the import
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406c code review 91, about 94 after the fold-in; Q-284). Specifies ADR-307, ADR-308, ADR-311 on the console.
**Decision:** (1) The console gains one page, `/console/content` ("Content"), for platform admins, with two tabs: Daily
challenge and Word bank. The other tabs of the wireframe (templates, level titles, XP table) come with their own tasks;
the Questify quests keep their page. (2) The schedule asks for 56 days from today's Questify day and lists every period
of the kind, so a period with no content is marked ("No challenge on this day / this week"); a period whose first day has
come is shown as Started and is read-only; a future one has Choose questions, Edit and Remove. (3) A period's editor
picks three ready questions that no other challenge holds, takes the sponsor name in both languages (both or neither) and
previews the questions with the right option marked and the sponsor line in both languages. (4) The question bank is read
in full (pages of 100); a question can be edited until its challenge starts and retired only while no challenge holds it,
after a confirmation. (5) The period control sits on each tab: a daily or weekly choice, "A change applies from tomorrow",
the pending change, and after a save either the day it applies from, "nothing changed" (asking for the current length drops a
pending change), and the count of items left on days that no longer start a period. (6) Stranded content (the API's
`unused`) is listed with **Remove** and an explanation to schedule it again on a period start: the plan said "Move it", but
the console read does not return a stranded row's content and no door moves one, so a one-click move would need a new door.
(7) The guess list import takes one word per line, pasted or from a text file (at most 5 MB), drops blanks and repeats,
holds back lines over 40 characters (the API would refuse the whole call), sends at most 20,000 words per call, stops at
the first failure, and shows the refused lines (the first 50); the same box removes words. No word list ships (Q-281). (8)
Warnings use the server's flags: the challenge warns under 7 days or 2 periods, each word language under 2 periods; a tab
carries a "!" mark and the console home's Content link a "Needs attention" mark while any warns. (9) Every write carries an
Idempotency-Key, one at a time, and the page reads the schedule again after it (the bank too only after a question or
challenge write); the key is kept only after a dropped connection or a 5xx, so a retry after a refusal is a new request.
(10) Remove always asks first, and the dialog says the content is deleted for good (a challenge's questions go back to the
bank; a word has to be typed again). (11) The tabs are plain buttons with `aria-pressed`; the "!" mark has screen-reader text.
**Why:** The plan's surfaces (T-406c) on the doors T-406 built, with no new door; marks in text so colour is never alone.
**Trade-offs:** No one-click move of stranded content; a bank of thousands is read in several calls; the 56-day window under
a daily cadence is a long list; the mark on the console home costs one extra read per visit.

## ADR-316 — T-407 split, and marketing consent as a dated log with a state the log writes
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-407 code review 86, about 93 after the fold-in; Q-285). Specifies ADR-065 and F-140.
**Decision:** (1) T-407 is split: **T-407** the server, the shared schemas, the web (the event form's interests, the
opt-out page); **T-407b** the app screens; **T-407c** (core, small) the "set your interests" Questify quest metric. (2)
Consent is per channel (push, SMS, email), off until a recorded yes. Every change is one row in an append-only log
(`marketing_consent`: channel, yes or no, method `signup`, `settings` or `opt_out_link`, the wording version for a yes,
the time); a trigger on the log writes the current state (`marketing_state`), so state and log cannot disagree, and a
partial index on the opted-in rows serves the audience. (3) The first answer is recorded for all three channels even
when every one stays off, so "Skip" at sign-up is three dated opt-outs (FR-735) and the app asks only once (`asked`
comes from the state rows); later saves record only channels that changed. (4) The sign-up step is an app screen shown
once after sign-up, driven by `GET /v1/me` `marketing {asked, canOptIn}`; no sign-in function changes. (5) A consent
that turns a channel on, sent with a wording version other than the one in force, is refused (409 `consent_text_outdated`),
so a yes is always a yes to the text on screen. A body that only turns channels off saves whatever the version (review
finding 1): otherwise the Settings opt-out from an old app, or "No offers, thanks" after a wording change, would be refused
and the one-time step could not be dismissed. The app also remembers an answer saved in this run, so a failed profile
read afterwards cannot show the step again. The wording is versioned: its text changed in review, so the version is "2". (6) A platform admin reads a player's channels and log through one audited door (no contact
shown). (7) Consent is erased with the account (Q-289).
**Why:** PDPL IR Art. 11 and 12 (per purpose, documented with time and method, withdrawal as easy as consent), CST 4.6.6
(proof of consent, opt-out), FR-1113, and a race-free state for the sender that needs no log scan.
**Trade-offs:** A player who skips is recorded as three opt-outs, which is accurate but more rows; a wording change
needs an app release (the wording ships in the app, ADR-073).

## ADR-317 — A possible minor is never offered or accepted for marketing; a signed link opts out with no sign-in
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-407 code review 86, about 93 after the fold-in; Q-285). Specifies STORE_COMPLIANCE §3.1. Q-286 and Q-288 stay open for Dhia and counsel.
**Decision:** (1) Marketing consent needs full legal capacity (IR Art. 11), and the age that means is "to check with
counsel". Build-around: a player may opt in only when this Riyadh year minus the birth year is at least 19 (a birth
year alone proves 18 only from the year after). Anyone else is refused (403 `consent_age`), is not shown the sign-up
step (`canOptIn` false), and can still turn any channel off. One number in `marketing_adult`; no guardian flow is built. `marketing_audience`
re-checks `marketing_adult` (a join on the birth year), so a promotion cannot reach a player below the age by construction,
whatever state an older opt-in left (review finding 3).
(2) Every promotional message carries an opt-out link: a stateless token (player id, channel and a 16-byte HMAC tag
keyed from `AUTH_SECRET`, purpose `marketing-opt-out`), no expiry, constant-time check. `POST
/v1/public/marketing/opt-out` answers 204 for any validly signed token (a known player, an unknown one and one already
off look the same) and 400 for a malformed or forged one; 30 tries an hour per address. The web page `/[lang]/opt-out`
asks first and posts on a button, because mail programs and link scanners open links. The link turns a channel off and
never on.
**Why:** A guessed-wrong age rule on opt-in is the costlier mistake; an opt-out that needs a sign-in is not "as easy as
giving consent" (IR Art. 12).
**Trade-offs:** Some real 18-year-olds cannot opt in until counsel answers; rotating `AUTH_SECRET` breaks old links
(it already signs everyone out).

## ADR-318 — Promotions choose recipients at one door and SMS keeps CST's quiet hours
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-407 code review 86, about 93 after the fold-in; Q-285). Specifies ADR-065, FR-737, FR-1111, FR-1738. Q-287 answered by Dhia: SMS only.
**Decision:** (1) Every promotional sender (T-409, T-501, T-706) chooses its recipients through `marketing_audience`:
active players opted in on the channel now, optionally in a city or holding any of some interests, by player id,
at most 1000 a page, ids only. It reads at send time, so an opt-out takes effect at once (inside FR-1738's 24 hours).
(2) `promoSendTime(channel, at)` moves a promotional SMS out of 22:00 to 09:00 Saudi time, and out of 01:00 to 12:00 in
Ramadan, to the end of the window. Ramadan comes from the Umm al-Qura calendar (`Intl`); the sighting can differ by a
day, so a day beside a non-Ramadan day takes both windows (nothing 22:00 to 12:00). (3) Push and email have no window,
as ADR-065 decided; a one-line set decides which channels have one.
**Why:** One door means "only opted-in players" is checked in one place and tested once; the window is a CST rule for SMS.
**Trade-offs:** A promotional SMS at the edges of Ramadan may wait a few hours more than the sighting needs; a promotional
push at 03:00 is allowed until Dhia says otherwise.

## ADR-319 — Interests are a seeded catalog, an event holds up to three, and "For you" is a plain match
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-407 code review 86, about 93 after the fold-in; Q-285). Specifies FR-733, FR-734, FR-710.
**Decision:** (1) `interest`: 12 seeded, bilingual, ordered ids (sport, music, tech, gaming, food, art, culture,
learning, business, family, wellness, travel); read-only until the console edits catalogs (T-703/T-709), like `city`.
(2) A player's city (from `city`) and up to 8 interests live in `player_preference`, private to the player: no public
profile, organizer or console door reads them. (3) An event holds up to 3 interests (`event.interests`, set by the event
team through the existing column grant; a trigger keeps them to catalog ids, distinct, in catalog order). (4) "For you"
lists events the public list shows (public, listing itself, scheduled or live) that the caller has not joined and that
share an interest with the caller or lie in the caller's city; order: both, then interests, then city; inside a group
more shared interests, then the soonest start; at most 20, no cursor. No interests and no city: an empty list. (5) The
The "set your interests" Questify quest (FR-710) needs a new metric counted by `questify_sync`, which pays XP; it is core
and is T-407c, which counts interests only, not a city (the reviewer's call). The list is named "Suggested for you" / «مقترحة لك» on screen.
**Why:** FR-734's examples are exactly this match; a closed catalog keeps matching exact and the choice quick; the XP
evaluator is core and has its own review.
**Trade-offs:** Fixed catalog until the console edits it; an event with no interests is shown by city only.

## ADR-320 — "Set your interests" is an always-on, met-or-not Questify quest metric
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-407c plan review 92, code review 87 with one BLOCKER fixed, re-review 93 GO; Q-290). Specifies FR-710, ADR-278, ADR-319.
**Decision:** (1) A new `questify_quest.metric` value, `interests_set`: `player_metrics` answers 1 when the player's
`player_preference` row holds at least one interest, else 0; the city is never read (the T-407 reviewer's call). (2) It
is lifetime only (no row for a bounded call), and a named table CHECK keeps it always-on with target 1, since it is a
state with no date to place in a campaign window. (3) One seeded active quest, "Set your interests" / «اختر اهتماماتك»,
100 XP and 10 gems, position 3; a player who already chose interests is paid at the next sync (ADR-279). (4) Paid once
ever through the existing evaluator; clearing interests never takes it back. (5) The player-facing quest card schema
takes any bounded metric string, so a metric added later cannot break an installed app's list; the console schemas stay
closed. (6) The app syncs right after a save that holds an interest, and the undone card links to the Interests screen.
**Why:** The smallest change in the payer's path: one read-only row in `player_metrics`, no restated payer, no new lock
edge (`set_preferences` holds `player` FOR NO KEY UPDATE, which the sync's KEY SHARE never waits on).
**Trade-offs:** A one-tap quest gives free XP and gems to every new account (gems are per account and cannot move); a
player who sets and clears before any sync is not paid. Retiring this quest and adding a new "set your interests" quest pays everyone who already has interests a second time (each quest pays once per player, not the metric); the console warns when a second one is saved beside one not retired. Installed app builds have the closed metric
list in their schema and fail to parse the quest list once 0071 ships: the server and a new app build deploy together.
Amounts decided under Q-290 (developer, delegated by Dhia, 2026-10-27); this ADR stays Proposed until the code review.

## ADR-321 — T-408 splits into the core ranking server, the app screens and the console page
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-408 code review 93, about 95 after the fold-in; Q-291). Specifies FR-611, FR-612, FR-830 to FR-833, FR-1614, FR-1786.
**Decision:** T-408 (CORE): migration 0072, the ranking doors, `GET /v1/questify/ranking`, the admin season reads,
shared schemas and the `questifyRanking` switch. T-408b (standard): the bar outside events, Questify Home, Explore and
the join-QR scanner. T-408c (standard): the console's Seasons page. Plan: `docs/plans/2026-10-27-t-408-questify-home.md`.
**Why:** The ranking restates `xp_apply`, the one function every XP payer calls, so it takes the core bar; the screens
do not, and one worker cannot carry all three well.
**Trade-offs:** Three reviews instead of one; the screens wait for the server.

## ADR-322 — The Questify-wide ranking: one board table kept by xp_apply, read from PostgreSQL
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-408 code review 93, about 95 after the fold-in; Q-291). Specifies FR-611, FR-605, FR-606, FR-120; T-401's note.
**Decision:** (1) `xp_board(board, player_id, xp, xp_version)`, board `all` (lifetime, equal to `player_xp.xp`) or a
Questify month `YYYY-MM` (the XP credited that month by `created_at`, less the removals of those credits: a removal
counts in the month of the credit it reverses, so a month row is never negative; plan review MAJOR-1), index `(board, xp DESC, xp_version) WHERE xp > 0`. (2) Written only by `xp_apply` while it holds the
player's `player_xp` row lock, so the boards equal the ledger in every transaction; the month comes from the entry's
`created_at` (the reversed credit's for a removal). (3) Ties: the lower `xp_version` first, the highest entry id applied
to the row (`greatest`, so it only grows). (4) Ranked: an active player
with XP above 0 on that board; deleted tombstones and banned players never show and never push anyone down. No hide
option, no gems, no player id in any answer. (5) Read from PostgreSQL (top 10 from the index, the reader's place by
counting the rows ahead), each door one SQL statement so rows and `me` share one snapshot; no `total`. (6) A platform switch, `questifyRanking`, hides it; the boards keep being written.
**Why:** A new table leaves `player_xp` alone, while adding a column to it would need ACCESS EXCLUSIVE and could
deadlock with the daily finish or the sync during the migration. As built, the table has no foreign key either: the
upgrade test showed the key's check taking KEY SHARE on `player_xp` rows that a daily finish holds FOR UPDATE while it
waits on `xp_entry` behind the migration. 0072 locks `xp_entry` ACCESS EXCLUSIVE, then `player` SHARE (for
`player_inactive_idx`; no writer of `player` touches `xp_entry`). Redis exists for the event ranking's scan bursts
(ADR-118); the Questify board moves at the pace of one player's XP.
**Trade-offs:** The reader's place costs O(rank). Timing (`test/perf/questify-ranking-timing.int.test.ts`, by hand):
100,000 ranked players on both boards (1% banned), `VACUUM ANALYZE`, the last-placed reader 200 times per board, on
Dhia's PC (16 threads, Docker PostgreSQL 17.11, other workers' suites running): first build, p95 107 ms (lifetime) and
108 ms (month). With the planned fallback (an index-only count of the rows ahead, less the inactive players ahead found
through `player_inactive_idx`, each looked up by key): p50 47 and 48 ms, p95 59 and 62 ms while other suites ran; run
on its own (code review MINOR-1): p50 31 and 32 ms, **p95 36.9 ms (lifetime) and 37.5 ms (month)**, so the 50 ms gate
is met at 100,000. Most of it is the count of about 100,000 index entries; taking off the inactive players grows with
deleted accounts. The Redis copy is task T-408d, triggered by the RUNBOOK check at about 30,000 ranked players. The lifetime XP is stored
twice (a DB check keeps them equal).

## ADR-323 — Ranking seasons are Questify months, archived by keeping their boards
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-408 code review 93, about 95 after the fold-in; Q-292
answered by Dhia, 2026-10-27: "Automatic monthly"). Specifies FR-1786 (amended), FR-611.
**Decision:** A season is a Questify month: it changes at 04:00 Riyadh time on the 1st, the Questify day's edge
(ADR-297), so a late-night daily play counts in the month of its Questify day. The new month's board starts empty by its
key, with no job and nothing deleted; every past month's board stays as that season's archive, read with today's rule
(a player banned or deleted later drops out of it). A past board changes only when one of its own credits is removed
(the removal counts in the credit's month, ADR-322). Lifetime XP and levels are never touched. The console lists the
seasons with their ranked counts and shows each one's top 10. No admin reset, admin-set schedule, season length or
season prize.
**Why:** The smallest thing that meets FR-1786: the reset and the archive fall out of the board's key, so nothing can
fail at midnight.
**Trade-offs:** FR-611 says "calendar month"; the season starts four hours after midnight. An admin cannot reset a
season early or change its length.

## ADR-324 — The Questify home center button opens event joins only
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-408b code review 82, about 93 after the fold-in). Specifies FR-831, FR-1614.
**Decision:** The scanner checks for an operator invite first (`inviteTokenOf`; it opens its invite, how staff join an
event), then reads with the event scanner's classifier: a join link opens that event's join card (a rehearsal code
only if a rehearsal QR exists); a quest, screen, passport-step,
hidden-category or meet code says to open the event first; anything else says it is not an event join code.
**Why:** Staff who are not yet in the event hold an invite QR; refusing it here while the event scanner takes it would
send them to the phone's camera app.
**Trade-offs:** Two kinds of code open from the button where FR-1614 names one.

## ADR-325 — Questify Home and Explore: what lives where
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-408b code review 82, about 93 after the fold-in). Specifies FR-832, FR-833.
**Decision:** Home holds the player's events (live, coming up, past; the newest 5 past, then the event history), the daily cards, the
streak line, the Questify quests button and the typed code. Explore holds, in this order, For you, the Questify-wide ranking and the
public events (a list that pages, so it comes last). The public events moved off Home, so signed-out Home is sign-in and the typed
code, and Explore is where anyone browses before signing in. The Shop tab is the gem shop and drops its Back button. There is no
separate For you screen or route.
**Why:** One home for each kind of thing; a long, paged list does not push the ranking out of reach; a bar tab has no "back".
**Trade-offs:** A signed-out player reaches the public events one tap further than before (the Explore tab).

## ADR-326 — The console's Ranking seasons page: its name and one open month at a time
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-408c build, Q-295). Specifies FR-1786.
**Decision:** The page is `/console/seasons`, titled "Ranking seasons" (Arabic «مواسم الترتيب»), with a link on the console
home. It lists every Questify month newest first with its ranked count and a "Current" badge; a month opens in place to show
its top 10 (rank, avatar, username, XP, lifetime level), one month at a time, the current month open on arrival. The top 10 is
read when a month opens, not with the list. The page is read only. A month with nobody ranked says so.
**Why:** The console's Arabic already calls campaigns «المواسم» (Questify quests page), so a bare «المواسم» would name two
pages alike; the English "Seasons" stays out of the same confusion by saying "Ranking". One open month keeps the list short
and the page on one screen on a phone; reading a month's rows on opening avoids fetching ten boards for a list of months.
**Trade-offs:** Two months cannot be compared side by side. Each opening reads the month again, which is one cheap indexed read.

## ADR-327 — The daily word guess lists: SCOWL for English, Wikidata Lexemes for Arabic
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406d build, Q-296). Specifies FR-1811; follows Q-281 ("open lists plus our picks").
**Decision:** The two valid-guess lists are files in `data/word-lists/`, `guess-list-en.txt` (8,863 words) and
`guess-list-ar.txt` (119,023 words), one normalized five-letter word per line, sorted, that a platform admin imports in
the console (Content, Word bank, Import). English comes from SCOWL (the English Speller Database), size 80 with
American, British and Canadian spellings, keeping only lower-case words. Arabic comes from the Arabic lexemes of Wikidata
(CC0): every lemma and form folded to the 33-letter set, five letters kept, every spelling that any lexeme files as a proper noun left out,
the definite article put before three-letter nouns and adjectives, and strings no Arabic word has (three equal letters
in a row, two hamza letters or two alefs together) dropped. Both lists leave out the words SCOWL marks offensive or
vulgar, the five-letter words of the LDNOOBW list for the language, and a short list of slurs and explicit terms in
`scripts/build-word-lists.mjs`. Sources, exact licences, checksums, the attribution texts and the sources refused
(share-alike, copyleft, non-commercial or unclear terms) are recorded in `docs/legal/THIRD_PARTY.md`, the file that
already lists the username word lists, not in a second `docs/THIRD_PARTY.md`. The notice SCOWL requires travels with the
data in `data/word-lists/NOTICE.txt`. `scripts/build-word-lists.mjs` rebuilds both files from the downloads;
`apps/web/src/lib/word-list-files.test.ts` keeps their format honest.
**Why:** SCOWL is the one large English list with an explicit permission notice that asks only for attribution and carries
every inflected form; Wikidata Lexemes is the only large Arabic source found that is CC0 (the others were share-alike,
copyleft, non-commercial or unclear), and it holds inflected forms, which an Arabic guess list needs because most
five-letter Arabic words are inflections.
**Trade-offs:** The Arabic list is permissive: it includes the bot-generated conjugations of about 27,000 verbs (some
forms are grammatical but rare), and a few junk lexemes and names filed as nouns slip through. A guess list only decides
which strings are accepted, so this costs little; the console's remove import prunes it. The English list is smaller than
the largest word-game lists because size 85 would need a prominent in-product notice. The offensive-word filter is best
effort; an Arabic reader should skim it (Q-296). The daily words, hand-picked by the team, come from no source.

## ADR-328 — The console imports a guess list in calls of 500 words
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-406d build, Q-297). Amends ADR-315.
**Decision:** The console sends a pasted or uploaded list in calls of at most 500 words (`IMPORT_CALL_WORDS`); the API
and the database keep their limit of 20,000 words a call.
**Why:** Measured in T-406d, `word_list_change` spends about 1.4 ms a word on a laptop (500 words 0.7 s, 5,000 words 6.4 s,
the English list in one call 11 s), because `word_norm` runs three times per word, each run through nested functions that
carry their own `search_path`. The API gives a statement 5 s (`pool-options.ts`), so the 20,000-word calls the console sent
would time out for any list above about 3,500 words, and neither shipped list would import. 500 words leave a margin of
seven.
**Trade-offs:** The Arabic list takes about 240 calls, about three minutes, once. When a call fails the console keeps the counts
of the calls before it and says how far it got ("Stopped after N of M words"); sending the list again repeats those calls
with new Idempotency-Keys, which is accepted: adds change nothing already there, and each call leaves one audit row (about
239 for a full Arabic import). A faster `word_list_change` (normalize each
input once, without the nested functions) would allow bigger calls; it touches core SQL and waits for a reason (Q-297).

## ADR-329 — Questify invitations are requested on the web and approved in the console; T-409 splits in two
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-409 plan; plan reviews 84 and 86 folded; Q-298). Specifies FR-738, FR-740, F-139 under ADR-047, ADR-064 and ADR-076.
**Decision:** (1) "Billed on the web" means: the organizer's owner requests an invitation campaign in the web dashboard;
the Questify team agrees the price with the organizer outside the platform (ADR-076); a Questify admin approves it in
the console with the channels, a message cap and a send time, or refuses it with a note. The platform holds no price,
invoice, VAT or payment field; the dashboard says nothing is charged there. The mobile app has no invitation screen,
link or purchase (PD-22). There is no add-on gate: the admin's approval is the commercial gate. (2) T-409 (core) is the
server: migration 0073, the doors, the sender, the routes, the name rule, the shared schemas and the
`invitationCampaigns` switch. T-409b (standard) is the web: the dashboard page, the console pages and the invitation
landing page. Plan: `docs/plans/2026-10-27-t-409-questify-invitations.md`.
**Why:** ADR-076, accepted by Dhia, already keeps prices and payment off the platform; the activation request (T-210) is
the same request-then-approve shape. The server touches consent, tenant isolation and admin powers (core); the pages do
not.
**Trade-offs:** No self-serve purchase; every campaign waits for a person. Two reviews instead of one.

## ADR-330 — Invitation campaigns: who asks, for which events, by which criteria, through which states
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-409 plan; plan reviews 84 and 86 folded; Q-299). Specifies FR-738, ADR-047, ADR-077.
**Decision:** (1) The owner requests and cancels; owners and editors in scope read the results; admins approve, refuse
and cancel. (2) Eligible events in v1 (`invitation_event_ok`): **public events only** (unlisted and private are left
out; developer's decision at the plan review), scheduled or live, ending at least 24 hours later, joinable by link, not
guest-list-only, no email-domain lock; checked at request, approval and start, and at every claim without the 24-hour
rule (a change mid-send skips the rest as `event_changed`). (3) One open campaign per event. (4) Criteria, all optional:
one city, up to 3 interests (the player's stated interests, any of), and history `none`, `recent` (joined any event in
the last 365 days) or `own` (joined another event of this organizer); never a named event of another organizer. (5) The
owner asks for a size (50 to 100,000); the admin sets the cap, the hard maximum of messages. (6) States `requested`,
`approved`, `sending`, `sent`, `cancelled`, `refused`, with `end_reason` `owner`, `admin`, `too_small`, `event_changed`
or `event_over`. The system cancels a campaign that matches fewer than 50 players or whose event no longer qualifies at
the start, and one whose event ends before it starts. When the event ends while messages are still queued (the switch
off, no promotional sender, a hold, quiet hours), settle skips them and finishes the campaign as `sent` with
`end_reason = 'event_over'`. Every end sets `finished_at`, so the 90-day purge reaches every row. (7) A platform switch,
`invitationCampaigns`, off when absent; off stops starting and claiming (a kill switch), never settle.
**Why:** The invitee must be able to join from the link at once, and an unlisted event is one its organizer chose not to
advertise; one open campaign and a human approval stop probing and spam; "own" re-engages the organizer's past
attendees without giving it any list; nothing may wait forever for a sender that will never come.
**Trade-offs:** Unlisted and private events cannot be promoted this way; history targeting is coarse; a paid campaign
whose event ends first sends fewer messages than its cap.

## ADR-331 — Invitations go by SMS in v1; the admin approves the exact text, which is frozen; the player's consent language
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-409 plan; plan reviews 84 and 86 folded; Q-300). Specifies FR-737, FR-1111, FR-1112, FR-1114; amends ADR-318 (1) and supersedes the T-407 note on T-409 ("only through `marketing_audience`").
**Decision:** (1) SMS only in v1, from a promotional Msegat sender configured as `MSEGAT_PROMO_SENDER` (the registered
"-AD" name, Q-034); without it SMS cannot be approved, and the server refuses to start when it equals the service
sender `MSEGAT_SENDER`. The `channels` column stays; T-501 adds push and the order between channels; email waits for
T-706's promotional email sender (separate from the sign-in mailbox, with `List-Unsubscribe`). (2) One message per
player per campaign. At most one invitation per player per 7 days: a `queued` or `sending` row always counts, a `sent`
or `unknown` row counts while its `sent_at` is within 7 days. (3) A fixed template, no brand prefix (the "-AD" sender
name identifies Questify), gender-neutral, at most 3 SMS parts: «دعوة إلى {event}: {link}» then «إيقاف العروض: {optOut}»
(English alike). The organizer writes no text. (4) **The admin approves the exact text.** The console shows the event's
names and the rendered messages; approve sends back the names it showed and fails with `event_renamed` when the event's
names have changed since; otherwise the names are copied onto the campaign and every message is rendered from that copy,
so a later rename changes nothing sent. (5) A name rule filters names before an admin sees them: on the NFKC form, no
control or format character (`\p{Cc}`, `\p{Cf}`), no `://` or `@`, no dot-like character between two letters or digits
of any script, no run of 9 or more digits of any script once everything but letters and digits is removed; also on the
cut text as sent. It lives in TypeScript (`\p{...}` classes do not depend on the database's locale). It is a filter, not
the gate: spelled-out forms ("example dot com") are the admin's to catch. (6) The message's language is the language of
the player's latest consent row on that channel: `marketing_consent` and `marketing_state` gain `language`, recorded by
`set_marketing(..., lang text DEFAULT NULL)` from the request's `accept-language`; NULL (older rows, or a 3-argument
call during the deploy) is read as Arabic. (7) The consent rule lives in one plain `LANGUAGE sql STABLE` function,
`promo_pool` (not a definer, no grant); `marketing_audience` is restated over it and allowed only in system context; the
fill and the claim's re-check name it.
**Why:** SMS is the only promotional channel before T-501; a weekly limit keeps promotions from becoming spam (ADR-065's
warning); an admin who approves the exact frozen text is the only reliable check against a phishing line sent under
Questify's promotional sender; the consent's language is the best signal the server has.
**Trade-offs:** No email or push reach yet; a player who consented before 0073 gets Arabic until they change a setting;
an organizer who renames the event after approval sends the old name; a rename between preview and approval makes the
admin approve again.

## ADR-332 — Invitation results are rounded daily counts, and what they can still imply
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-409 plan; plan reviews 84 and 86 folded; Q-301). Specifies FR-739, ADR-047, PD-27.
**Decision:** (1) Sent = handed to the provider (sent or unknown). (2) Opened = the invitation link opened: the landing
page reads the token from the URL fragment (`/{lang}/i#{token}`, never in a server log or a `Referer`), clears it and
posts it, marking the recipient once; no pixel, no SDK, no third party; its own rate-limit bucket. (3) Joined = a
recipient with an enrollment in the event (not pending or declined) joined after their message, counted on the server
until the event ends or 30 days after sending; no enrollment is marked as invited. (4) Organizers see only
daily-published numbers, bucketed in SQL: below 10 shown as "fewer than 10", otherwise rounded down to a multiple of 10;
a campaign that matches fewer than 50 players is not sent; organizer-readable audit rows carry no counts. Admins see
exact counts. (5) Recipient rows are deleted 90 days after the campaign finished (whatever their state); the counts stay
on the campaign; erasure deletes a player's rows at once. (6) The privacy policy says so (T-807): "When an organizer
pays Questify to invite players, the organizer sees how many received, opened and joined, in rounded daily numbers,
never who. Because the organizer also sees when each member joined its event, it may guess that someone who joined soon
after an invitation went out was invited."
**Why:** No answer names a player or numbers a group under 10. This does not make the counts untraceable: the organizer
sees the campaign's send date and its member list shows every member's `joinedAt` in join order, so on any event a burst
of joins soon after the send hints at who was invited (and so opted in and matched the criteria); on a quiet event the
joined count alone can. That comes with publishing a joined count at all (FR-739); the rounding, the minimum of 50 and
the daily delay make the guess coarser, not impossible.
**Trade-offs:** Organizers see coarse, day-old numbers; opened undercounts browsers that block scripts and counts
forwarded links.

## ADR-333 — Invitations are sent by the in-process tick, at most once per player
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-409 plan; plan reviews 84 and 86 folded; Q-302). Specifies rule 5 (timeouts, safe retry, fallback) and FR-1738.
**Decision:** (1) The jittered in-process tick of T-306b and T-402b runs every 5 seconds with a 3-second budget while the
switch is on: start one due campaign (a second server that cannot take `pg_try_advisory_xact_lock` skips the fill), then
rounds of 5 (claim up to 5, send them concurrently, acknowledge each as it returns) while the budget lasts; settle runs
every 10 minutes whether the switch is on or off. No release door: every claimed row is sent in its round. pg-boss is not
introduced. (2) At most once: lease expiry (in the claim and in settle) locks the affected campaigns
`FOR NO KEY UPDATE ORDER BY id`, then their stale rows `SKIP LOCKED`, sets them `unknown` and clears the lease token; an
acknowledgement changes a row only when it is still `sending` with the same lease token, so a late answer never rewrites
an `unknown` row, and an `unknown` row is never sent again. The sender retries only a request that provably never left.
(3) A refusal for the number fails that message. A refusal for the account (balance, sender, address, unreachable)
holds the whole SMS channel for 15 minutes, puts the message back without counting an attempt (only while its campaign
is still sending, otherwise it is cancelled), logs an error-level alert, and the tick claims no further round until the
hold ends. (4) Quiet hours in two bands: the fixed 22:00–09:00 Riyadh band, checked in TypeScript and again inside
`invitation_claim`, and in Ramadan TypeScript's 01:00–12:00, so in Ramadan nothing goes 22:00–12:00; approval moves a
send time out of both and says so. (5) Each message is re-checked at the claim: consent through `promo_pool`,
membership, the event's end and the event rule (`event_changed`). (6) Lock order: event, campaigns, recipient rows,
channel hold; no player, enrollment, consent or ledger row is locked (added to `docs/rules.md` with the build).
**Why:** The tick and lease pattern already runs in production code and is tested; a duplicate promotional SMS costs
money and annoys, a lost one costs little; an account problem is the same for every message, so it pauses the channel,
not one message; the SQL band keeps a TypeScript bug from sending at night.
**Trade-offs:** A crash after the provider accepts a message counts it as `unknown`; a long send crossing 22:00 resumes
the next morning (the next noon in Ramadan).

## ADR-334 — Where the T-409 build departs from its plan
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-409 code review 89, all departures accepted as built; Q-303). Amends ADR-330 (2), ADR-331 (1) and ADR-333 (1) to (3) in the details below; the plan's other lines are built as written.
**Decision:** (1) **The start does not apply the 24-hour rule.** The request and the approval do; the start, like every
claim, checks only that the event still qualifies (`invitation_event_ok(ev, true)`) and is not over. With the rule at the
start, any send time the approval allows in the event's last day (up to an hour before the end) would cancel the
campaign. (2) **The claim locks the sending campaigns `FOR NO KEY UPDATE`, not `FOR KEY SHARE`**, in one statement in id
order with every campaign that has an expired lease: it moves the skipped counter, and a `KEY SHARE` upgraded to an
update could deadlock with an admin's cancel (`FOR UPDATE`). Two servers' claims run one after the other (milliseconds).
Settle locks every campaign it may change `FOR UPDATE`, also in one statement. (3) **`invitation_recipient` has no foreign
keys and a `bigint` identity id.** Measured on 100,000 inserted rows (scratch benchmark, 2026-10-27): 11.8 s with both
keys and a uuid id, 6.8 s with the campaign key only, 2.3 s with neither; the player key also took `FOR KEY SHARE` on
every player a fill picks, which the lock order forbids. Rows are written only by the fill under its campaign's lock for
players read through `promo_pool`; players are never deleted; a trigger deletes a deleted campaign's rows (an admin
deleting the event). `marketing_adult` (no table read) and `invitation_candidates` lose their SET clauses so the planner
inlines them; the fill sorts with `work_mem` 64 MB. (4) **The fill took 4.0 s at 100,000 players on the development
laptop** (the console's estimate 0.7 s), missing the plan's 2 s gate there: the tick runs the start with its own 60 s
statement limit (the API's is 5 s), and the RUNBOOK asks for a measurement on CranL before the switch is turned on. (5)
**Account refusals also include `M0030`** (a sender without the "AD" ending) **and `M0090`** (a template mismatch): both are
account configuration that would otherwise fail every message of a paid campaign. (6) `availableChannels` reads whether
the promotional sender was built (`AppOptions.promoSmsSender`, from `MSEGAT_PROMO_SENDER`), not the config object. (7) The
owner's withdraw route is `DELETE …/events/{eventId}/invitation-campaigns/{campaignId}`, and its door checks that the
campaign is the event's. (8) The claim returns the recipient's link (the message's token) and no join code (unused). (9)
The organizer's first published numbers come on the first Questify day after the start day, never on the start day
itself, then daily and at the close. (10) An open counts only while the results are open and the event is not over; a
queued message's link shows the card without counting. (11) Settle answers `more` when a bound was reached and the tick
calls it up to five times. (12) The database tests are split in two files (`invitation-campaigns.int`,
`invitation-sending.int`).
**Why:** (1) and (5) make the accepted rules hold as meant; (2) keeps one lock order with no upgrade; (3) and (4) are
the measured cost of the fill; (6) to (12) are wiring.
**Code review fold-in (89, 2026-10-27):** the fill's limits are its own on both sides, the server's statement limit (60 s,
`SET LOCAL`) and the client's read limit (65 s, the pool's is 6 s), proven on a pool built from `poolOptions`
(`test/invitations/fill-limits`); the name rule also refuses default-ignorable characters and allows combining marks
around a dot; settle's purge also deletes a row a fill inserted for a player whose erasure committed during the fill; the
request's early name check reads only the caller's own events; a text that cannot be built is acknowledged `failed`
(`render_error`), never `unknown`.
**Trade-offs:** Integrity of `invitation_recipient`'s ids rests on its one writer and the trigger, not on foreign keys;
a fill of 100,000 holds the event `FOR SHARE` for seconds (an edit of that event waits). The 90-day purge is kept
(data minimisation, developer's decision at the code review): "never twice for one event" holds only while a campaign's
rows exist, so an event still running more than 90 days after a campaign finished could invite the same player again,
and only through a new campaign that an admin approves by hand. A name with an emoji's variation selector is refused
(the selector is default-ignorable); the admin sees the verdict.

## ADR-335 — The web pages for Questify invitations: what they show and where they differ from the plan
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-409b code review 92; Q-304). Specifies FR-738 and FR-739 on screen under ADR-329 to ADR-334.
**Decision:** (1) **The console detail renders the SMS text from the frozen names once a request is approved.** While a
request is `requested` it renders the event's current names (what Approve will freeze); in every later state it renders
`approvedNames`, so the console shows what goes out whatever the event is called now; a request refused or cancelled before
approval has no text (`messages: null`). This changes `campaignDetail` in the T-409 server code by one line (tested in
`campaigns.test.ts` and, from the browser, in `e2e/invitations.spec.ts`). (2) Approve is off, with the reason written next
to it, when SMS is not set up on the server, the event no longer qualifies, a name fails the name rule, or the event has no
name; the API still refuses each. Refuse and Cancel need a note (1 to 500 characters, the owner reads it); Cancel and the
owner's Withdraw ask for a browser confirmation (the ticket page's precedent). (3) Times in the owner's earliest-send field
and the console's send-time field are Riyadh time (the quiet hours are Riyadh hours); every displayed time names the zone.
(4) The Arabic word is «طلب دعوات» and the English "invitation request", never «حملة»/"campaign": the console already calls
Questify's quest seasons campaigns. (5) The event page links to Invitations only while the platform switch is on; the page
itself opens either way, says invitations are not open yet when the switch is off, and keeps showing earlier requests.
(6) The landing page has no language switch (it would drop the token, which is held in memory only), reads the token from
the fragment once, removes it from the address, sends it once, and shows the live public event card; after a reload it
says the link is incomplete. It carries no player data: the page is the same for everyone. (7) The console home links to
the queue with the number of requests waiting. (8) Code review fold-in: Approve and Refuse ask for a browser
confirmation first (Approve names the cap and the time, since one click can commit up to 100,000 messages); a failed
first read of a request goes to sign-in when the session ended and says the page could not load after a dropped
connection or a server fault, "not found" only when the API says so; the name-rule warnings show only while a request is
`requested`; counters and sizes are grouped with Western digits.
**Why:** The text an admin approves and the text the console later shows must be the same text; a disabled button with its
reason is quicker than a refused request; the zone of a time must never be guessed; one word for one thing.
**Trade-offs:** The server code that was reviewed (T-409) changed by one line after its review, so it is named in the
T-409 mutation run; the landing page cannot be switched to the other language after opening; a recipient who reloads the
landing page must open the link from the message again.

## ADR-336 — The shop window: set per event, only longer after the end, frozen once closed
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-410 plan; plan review 88 folded; Q-305). Specifies FR-750, FR-1018 under ADR-048.
**Decision:** (1) The organizer sets the days the shop stays open after the end on the dashboard's Rewards page (exists
since T-201): owner or editor in scope, 0 to 30 whole days, default 3; 0 closes the shop when the event ends. (2) The
shop closes exactly at `ends_at + shop_days_after` days (`shop_state`, unchanged): a request whose transaction began
before that moment is served as open, one that begins at or after it is refused. Ending early starts the window then.
(3) Before the end any value 0 to 30. After the end, while open, the window may only grow (still at most 30 days after
the end); shorter is refused (`409 shop_window_locked {reason: shorter}`). Once closed it is frozen, longer included
(`{reason: closed}`). Sending the current value is no change. (4) Enforced in the API (`apps/api/src/rewards/shop-window.ts`,
under the event lock `updateShop` already takes, with the state and "now" read from SQL, never the API's clock; the same
file maps the database's `SW409` reasons) and by a DB trigger on `shop_days_after` for the API's role, judged on
`clock_timestamp()` so an edit begun before the close cannot reopen it (`SW409`). The dashboard sends the days only when
that field changed, so a page loaded before a co-editor lengthened the window still saves its other settings. (5) No door moves an ended event back
to live and an ended event's times are frozen, so with the days frozen the close is permanent.
**Why:** Today a closed shop reopens if the days are raised, with the old balance still spendable; players are shown a
closing date that must not move earlier; organizers sometimes need more time for players to redeem.
**Trade-offs:** An organizer who set too long a window cannot shorten it after the end; a shop that closed by mistake
cannot be reopened (a later admin tool would need its own decision).

## ADR-337 — The event balance closes by rule, with no write; holds, codes and prizes keep their own rules; no archiving yet
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-410 plan; plan review 88 folded; Q-306). Specifies FR-750, FR-751, FR-1018 under ADR-048; relies on FR-1609.
**Decision:** (1) The balance closes when the shop window closes, as a rule: no ledger entry, no stored flag, no job.
From then the shop refuses (exists), every earning door adds to the score only (exists, FR-1710), Home drops the goal
and the app shows the balance as closed. The ledger stays append-only and the balance column still equals its sum.
(2) Not a `balance_close` ledger entry that zeroes the balance, because FR-1609's returns after the close would need
another entry each, earning doors that began before the close and commit after it would race the zeroing entry, and it
writes one row per member at one moment with a new kind every ledger reader must learn; not a stored
`balance_closed_at`, which would cache a fact derived from frozen inputs. (3) At the close: digital codes never given
stay unassigned and go to no one (kept encrypted until event-data retention, Q-075); delivered codes stay in My rewards;
shop holds not yet picked up stay collectible until their own pickup time, and a timeout or cancel returns the unit and
the points into the closed balance (FR-1603, FR-1609; with spend-lowers-rank the return mirrors its spend on the
score); rank prizes, quest-item handovers, desk holds and paused redeeming keep their own rules. (4) Score, final rank,
passport stamp, souvenirs and items, XP, level and achievements are never touched by the close; erasure keeps its rules;
the future event-data retention (Q-075) must exclude score, `final_rank`, `souvenir_receipt`, `player_item`, XP and
achievements. (5) The event stays Ended after the close: archiving (FR-1608's last step) is not built here, because an
archived event refuses the results' confirmation and reveal, leaves the operators' list (the desk could not hand over
late holds or rank prizes due up to 60 days later) and closes help-desk tickets. Deferred to **T-411**: a tick step
archives an ended event only when the shop is closed, no `reserved` redemption of any kind is left, results are
revealed or `ends_at` + 60 days has passed, and no help-desk ticket is open (developer's decision at the plan review).
**Why:** The rule already lives in one place (`shop_state`) and every door already obeys it; a write at the close adds
races and rows and removes nothing that matters, since the points record already explains every point.
**Trade-offs:** A leftover number stays on each enrollment for good (shown as closed, never spendable); a return after
the close gives the player nothing usable; FR-1608 stays partly delivered until T-411.

## ADR-338 — What players and organizers see around the close
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-410 plan; plan review 88 folded; Q-307). Specifies FR-750, FR-1018 on screen; follows ADR-300's copy rule.
**Decision:** (1) Home carries `shopWindow {state, closesAt, deskEndsAt}` (null when the shop switch is off). After the
end while open, a banner gives the closing date and time in the event's zone, never a countdown and never loss copy;
when the desk's last hours end before the close, a second line says items and experiences can be reserved until then
(`desk_finished`), digital rewards until the close. (2) Once
closed, Home's balance row reads "Closed" instead of a number with the closing date, and there is no goal card. (3) The
Rewards tab replaces the catalog with the closing date and "your {currency}, rank and stamp stay"; My rewards stays.
(4) Cancelling a hold after the close warns that returned points cannot be redeemed. (5) The dashboard's shop settings
show when the shop closes or closed, accept only higher days after the end and none once closed, and warn when the
desk's last hours end before the shop closes. (6) No push until
T-501, which owes one the day before the close.
**Why:** FR-750 says the balance shows as closed; a date tells players what they need without pressure; a number that
cannot be spent reads like money lost.
**Trade-offs:** A player who wants to know their unspent leftover adds it up from the points record.

## ADR-339 — The recap card: what it shows, and sharing it as an image made on the phone
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-410 plan; plan review 88 folded; Q-308). Specifies FR-752, F-141 under ADR-048.
**Decision:** (1) From the end, a member who played, as the passport counts it (not pending, declined, banned or
removed; `joined_via IS DISTINCT FROM 'rehearsal'`; `left` included), may read the recap; active members open "Your
recap" from Home. (2) It shows the event's name, local start date and city; the final rank once results are revealed
(the passport's rule, ADR-276), "comes with the results" while pending, nothing when unranked; quests done = distinct
quests among this enrollment's `quest` ledger entries that no removal reverses (not XP credits, which a removed first
completion loses for good); this event's souvenirs, up to 3 and "+N", left out when there are none; "Thanks for
joining" instead of zero quests. (3) Never: username, character, score, balance, player count, join code, link, QR,
any id. (4) Share captures the card as a PNG on the phone (`react-native-view-shot`) and opens the system share sheet
with the image alone (`expo-sharing` takes no text; the card names the event); nothing is uploaded, no link, no
tracking parameter, no analytics event; the previous capture is released before the next one and when the screen
closes, never as the call returns. Both native modules are detected before either package is loaded
(`requireOptionalNativeModule('ExpoSharing')`, `TurboModuleRegistry.get('RNViewShot')`, then a lazy `require`); when
either is missing (an older build) one fixed line is shared through React Native's `Share`. Never rewarded. (5) Arabic and English, right to left, Western digits, Gregorian dates. (6) `GET
/v1/events/{id}/recap` reads it through one definer, `event_recap`; nothing is stored.
**Why:** A card worth sharing is an image (ADR-048, the go-to-market's shareable recaps); making it on the phone keeps
the player's result off any public URL; the two modules are the standard Expo way and Android cannot share a file
through React Native's `Share`.
**Trade-offs:** Two new native dependencies and a new development build to see the image; the shared image carries no
text line; a rank stays pending while an organizer does not reveal results; the recap's quest count can differ from
Home's progress line for repeatable quests.

## ADR-340 — Where the T-410b build fills in the plan: the screens, the share split, the refusal words
**Status:** Accepted (developer, delegated by Dhia, 2026-10-27; T-410b code review 89; Q-309). Completes ADR-338 and ADR-339 on screen.
**Decision:** (1) **Home:** an active member sees the "Your recap" card (above the countdown) once the event is ended or
archived, and the shop's line under the standing card: "open until {date}" with the desk line (until its end, or "stopped"
once `deskEndsAt` is past), or "closed on {date}". The balance row reads "Closed" once the shop has closed, and the app drops
the goal itself whatever an older API sends. Home reads itself again a second after the shop's close or the desk's end, so
the screen changes on the server's word without a manual refresh. (2) **Rewards tab:** once closed, the catalog is not
offered; a panel says when it closed and that the balance can no longer be redeemed while the points, rank and stamp
stay; My rewards stays; the cancel confirmation adds the returned-points note. The tab shows no "open until" line while
the shop is open (Home does). (3) **The card** is drawn with the current theme and language (an image is a snapshot of the
screen) and names the souvenirs, three at most and "+N"; the quest line is «ما أنجزته من {questMany}: {count}» /
"{questCap} done: {count}", which needs no agreement with an organizer's renamed noun (ADR-058). (4) **The share is two
files:** `recap-share.ts` (the sharer, with the checks, the lazy load and the text share injected) and
`recap-share-native.ts` (the real `requireOptionalNativeModule('ExpoSharing')`, `TurboModuleRegistry.get('RNViewShot')`,
the lazy `require`s and React Native's `Share`). A package that is there but fails to load falls back to the text line. A
source-scan test fails any value import of the two packages outside that file. (5) **Dashboard:** the closing line shows for
a draft too (the date the shop would close on); a desk whose last window ends before the close gets the plain warning
paragraph (no `role`, which the low-codes note owns); after the end a shorter value is refused before sending, a closed
shop's field is read-only; each `shop_window_locked` reason has its own words (`describeProblem`), and the page reads the
shop again after one, so a stale page shows the real date; `daysAfter` goes only when it changed.
(6) **Test support:** the e2e control's `/event-status` takes `endedDaysAgo`, so a browser test can put an event inside or
past its shop window. (7) **Dependencies:** `react-native-view-shot` 5.1.0 (Expo SDK 57's pin; the registry's 6.2.1 is not
blessed for SDK 57) and `expo-sharing` ~57.0.24; neither asks for a permission or runs an install script.
(8) **Code review fold-in (89):** the Home read at the close tolerates a phone running ahead of the server: while the
shop is open, a boundary the phone's clock passed by under 2 minutes means "ask again in 15 seconds", and an older one
(a desk that ended days ago while the shop stays open) is ignored so Home never polls for days; the card is a passport
stamp grown up (a wood frame, a parchment panel with a gold edge, the stamp's gold-ringed emblem, gold-edged chips, no new
art); the source scan also catches a bare `import "pkg"`, `import("pkg")` and `export * from`, each proven by a case; "Your
recap" is never offered to a rehearsal account; the desk warning goes once the shop has closed.
**Why:** A card, a closing date and a closed balance are what the plan promised; the split makes the crash-safe path
testable without React Native; each refusal says what the organizer can do.
**Trade-offs:** The shared image follows the phone's theme and language, not a fixed poster; the Rewards tab does not repeat
the closing date while open; Home makes one more timer; a second small file for the share.

## ADR-341 — Archiving ended events: one tick step, guarded doors, and archived is final
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-411 code review 87, MAJOR folded, no re-review;
Q-310). Delivers FR-1608's last step under ADR-337 (5).
**Decision:** (1) `archive_ended_events()` is the lifecycle tick's last step, after the reservation timeout and the ticket
purge, so a hold that timed out in the same run no longer blocks. It takes no argument (anyone may call it; it applies
the rule), archives up to 100 due events a run, oldest end first, and audits each move as the other lifecycle moves
(`system`, `event.lifecycle`, ended → archived). (2) The rule is ADR-337 (5)'s plus the help desk's window, in one
internal function (`archive_due`): stored `ended`, shop closed by `shop_state`, **30 days since the end** (that moment
included), no `reserved` redemption of any kind, results revealed or `ends_at + 60 days` reached (that moment
included), no open ticket of the event in either queue (an escalated ticket still waits for Questify). The 30 days are
`open_ticket`'s own sending window (ADR-248): it refuses an archived event, so archiving at the shop's close (which can
be the end itself) would cut members' sending short. They also give organizers 30 days after the end to review pending
submissions, which are refused once archived (`SE409`). With the shop's window at most 30 days, the shop is always
closed by then; the shop condition stays as ADR-337 names it. An event the lifecycle has not yet moved to `ended` waits
for that move, which the same run makes first. (3) Concurrency: the step takes each event `FOR UPDATE SKIP LOCKED` and checks the rule again in the UPDATE,
after the lock; two BEFORE INSERT guards (`redemption_event_open`, `ticket_event_open`) read the event `FOR KEY SHARE`,
so a reservation, rank prize, quest item or ticket in flight either makes the step pass the event by this run or waits
for it and is refused as archived, with the door's own refusal (`RS403 closed`, `RF409 not_ended`, `QN403 ended`,
`HT403 sending_closed`): the API needs no new mapping. A reservation or ticket whose transaction began a moment before
the boundary (a 30-day shop closing with the sending window) and waited on the step is therefore refused, where it would
have been served had nothing archived the event in that instant. A reveal with no prizes that races the step can still
set `revealed_at` on an event the step has just archived: harmless, since it inserts no redemption, and its other
writes (the `event_result` update, the audit row, which has no foreign key) need no lock the step holds, so it commits
as before (`reveal_results`, 0034); a reveal with prizes inserts redemptions and is refused by the guard. No per-event exception block: nothing on the step's path
can fail today, so one would be speculative; the known risk is that a single failing row would roll back the whole
batch on every run and stall archiving, to revisit if a failure source appears (the RUNBOOK's `event.archive_failed`).
(4) Archived is final for every role: the API's role never had a right on `status`, no definer moves an
event out of archived, and `event_archived_final` refuses it for the owner connection too (`QE409 archived`).
(5) What archived means stays as built: organizer writes refuse it (`event_archived`), joining and new tickets refuse
it, the operators' list leaves it out; the player keeps every read (event list, Home with the shop closed, recap,
passport, public stamp, results, points record, My rewards, tickets, profile, locker, achievements), proven over HTTP.
**Why:** The step must never strand a hold, a prize or a ticket that only the desk or the team could settle, and a door
that checked the status a moment earlier must not slip a new one in after the move; reusing each door's own refusal
keeps the API unchanged. A final state that a support query could reverse would make every "archived" refusal soft.
**Trade-offs:** No event is archived within 30 days of its end, however early its shop closes. A team that never
answers a ticket delays archiving until the ticket is purged, 90 days after the latest of the event's end, the sending,
the escalation and the return (`purge_ended_tickets`, 0061); an event that is never revealed is archived at 60 days and can no longer be confirmed or revealed; un-archiving a mistake
would need a new migration and its own decision.

## ADR-342 — T-501 splits into seven slices; T-312b folds into the app slice
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501 plan, `docs/plans/2026-10-28-t-501-push.md`;
plan review 80 and re-review 88 folded; Q-311).
**Decision:** (1) **T-501** (core): the store, the doors, the push worker with a fake provider, the center, mute and
device routes. **T-501b** (core): the real APNs and FCM clients and their configuration. **T-501c** (standard): the app
(permission, token, center screen, mutes, deep links). **T-501d** (core): the owed personal pushes. **T-501e** (core):
the owed event pushes. **T-501f** (core): the streak and shop-closing reminders and push as an invitation channel.
**T-501g** (core, Could): FR-238's hint push. (2) T-312b (FR-1824's notification history) is the center screen T-501c
builds, so it is merged into T-501c. (3) No message is wired before T-501b, so the first real push has real clients.
(4) Go-live is gated by the RUNBOOK's push checklist (real keys, a real iPhone and Android phone, uninstall answers,
collapse, cold-start taps, Arabic on the lock screen), which T-806 needs before it is done.
**Why:** each slice is one review's worth: the data and consent rules, the outside calls and secrets, the app, then the
producers in batches that touch different core tables; the clients are tested against local servers, so only real
devices can prove them.
**Trade-offs:** seven reviews instead of one; FR-1101 and FR-1102 stay partly delivered until T-501f.

## ADR-343 — The push store: a notice, one center row per recipient, an outbox, a device per sign-in
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501 plan; plan review 80 and re-review 88 folded;
Q-312). Specifies FR-1104, FR-1824 and the DATA_MODEL placeholder `notification, notification_delivery`.
**Decision:** (1) `notice`: one row per thing that happened, with its kind, event, ids (`refs`), frozen public names
(`params`, cut in SQL to 40 characters), a unique `dedupe` key (the once-only marker) and an expiry (the kind's time to
live, or the producer's earlier `until`). (2) **A producer writes only the notice**: `notice_create` is one `INSERT ...
SELECT FROM notice_kind ... ON CONFLICT (dedupe) DO NOTHING`, reads no device, mute, consent or refresh row, has no CHECK
the producer's data can fail, and an unknown kind writes nothing; the worker writes every center row and send, personal
notices first (about a second later). Producers are set-based (statement-level triggers with transition tables for
bulk writes; `enrollment` keeps a row-level `WHEN` trigger, measured), never with per-row `EXCEPTION` blocks. (3)
`notification`: one row per recipient, **the record of every message**: every push points at one, a refused permission
or a muted topic still gets one, and the history lists them. (4) `push_send`: the outbox, one row per center row and
device, with its target, priority, expiry and `attempts`. (5) `push_device`: one per sign-in (the refresh family of
T-107), unique per token; pushable only while that family has a live refresh row, so sign-out, the 10-family limit and a
reused refresh token stop pushes with no change to sign-in code. (6) `push_topic_mute`. (7) Kinds are seeded rows
(`notice_kind`: class, topic, membership rule, priority, time to live), so each later slice adds rows instead of
widening CHECKs; every row must have a template (a DB test), and one without renders generic center text. (8)
Retention: center rows 180 days, outbox rows 7 days after their end, devices 60 days unseen or 7 days after invalid;
purges walk the primary key from the oldest id. (9) Erasure deletes the player's personal notices (cascading), center
rows, sends, devices and mutes; settle deletes the personal notices and center rows a racing producer or fan-out wrote for a player deleted in the
last 24 hours (a bounded scan of recent erasures). (10) The notice
holds no counters (no hot row).
**Why:** one record per recipient makes "the center holds every message" literal and the history a plain indexed read;
tying devices to the sign-in reuses the session rules that already exist; a producer that only inserts one row cannot
slow, lock or roll back the door it rides on.
**Trade-offs:** about 50,000 center rows per announcement at the largest event; no foreign key on
`notification.player_id` (the fan-out must not lock players; settle cleans orphans); the center row of a personal
message appears about a second after the decision.

## ADR-344 — APNs and FCM called directly behind one provider interface; nothing sent without keys
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501 plan; plan review 80 and re-review 88 folded;
Q-313). Specifies ADR-086 and INTEGRATIONS "Push".
**Decision:** (1) APNs over HTTP/2 with a token-based ES256 provider token (re-signed every 40 minutes), FCM HTTP v1 with
a service account's OAuth token; `node:http2`, `fetch` and `node:crypto` only (no new server dependency); the Gmail
sender's service-account token code is shared. (2) One `PushProvider` interface per target (`apns:production`,
`apns:sandbox`, `fcm`), each send given a deadline; a fake for tests. (3) Configuration all-or-none per provider
(`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_TOPIC`; `FCM_SERVICE_ACCOUNT`); a partial or malformed set
refuses to start; none set starts, sends nothing for that platform and logs it once at warn level in production. (4)
The startup check signs the APNs token once and fetches the FCM token in the background (failure holds FCM). (5) The
APNs environment is the device's own, read by the app with `expo-application`'s
`getIosPushNotificationServiceEnvironmentAsync()` at registration: `development` → sandbox; `production`, `null` or
an error → production (Expo's own rule for `getExpoPushTokenAsync`), because internal (ad hoc) builds use production
APNs whatever their EAS profile, and App Store and current TestFlight builds carry no provisioning profile to read
(`null`). A TestFlight install registering as production and receiving is a RUNBOOK go-live line.
**Why:** no relay sees the text (INTEGRATIONS); Dhia's Apple and Google accounts do not exist yet, so the store and
the center must work and be tested without them; the build profile does not tell the environment.
**Trade-offs:** two protocol clients to maintain; the first real push waits for Dhia's keys and the RUNBOOK checklist.

## ADR-345 — Sending: an in-process worker, leases that sends never outlive, requeue on outages, a breaker
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501 plan; plan review 80 and re-review 88 folded;
Q-314). Specifies rule 5 and NFR-004; the pattern of ADR-333 with the departures below.
**Decision:** (1) An in-process worker loop in the API container (ADR-109), not pg-boss, with **its own small pool**
(from `poolOptions`, at most 3 connections): fan-out (personal notices first, then 2,000 enrollments a call with a cursor
on the notice), then claim rounds of up to 200 rows, **at most 100 from one notice** (a per-notice `LATERAL` pick over
the index `(target, priority, notice_id, id) WHERE state = 'queued'`, no sort over the queue), by priority (personal,
event, promotional) then notice then id; a picked row past its expiry becomes `expired` (settle expires the rest by index). Several
instances share the outbox through `SKIP LOCKED`. (2) Sends go in waves of at most 50 per target, **each wave acked as
it ends**. (3) **No attempt starts that could end after the row's lease**: the deadline is the worker's monotonic clock
read before the claim, plus the 60 s lease minus 2 s (the host's clock is never compared with the database's); such a
row is requeued. In-lease tries are capped at `8 − attempts` and the ack writes `least(n, 8)`, so one row can never
break its wave's ack. (4) Outcomes: a definite 500 or 503 (after in-lease retries) is **requeued** and sent again until its
expiry; a connection that failed before writing is requeued with no attempt counted; a request APNs never processed
(`REFUSED_STREAM`, a stream above a `GOAWAY`, 503 `Shutdown`, 400 `IdleTimeout`) is requeued; only a timeout or reset
**after the request was written** is `unknown`, never resent; every attempt carries the same collapse id and Android tag;
`attempts` counts requests written, 8 means `failed`. At most once across leases as ADR-333 (2). (5) A breaker per
target: 10 consecutive 5xx or timeouts hold it 30 s, doubling to 15 minutes; one success resets it. Account and quota
refusals hold the target (15 minutes; FCM quota `Retry-After`, at least 60 s); held rows are requeued with no attempt
counted. (6) Invalid tokens: APNs 410 `Unregistered` and `ExpiredToken` and FCM `UNREGISTERED` always invalidate and are not counted by
the guard; the ambiguous codes (`BadDeviceToken`, `DeviceTokenNotForTopic`, `SENDER_ID_MISMATCH`, token-named
`INVALID_ARGUMENT`) invalidate unless 20 or more answers in a round from one target are more than half ambiguous, which
holds that target and invalidates none; a device re-registered after the claim is never invalidated. (7) Gate: 50,000
recipients fanned out in under 30 s on the laptop, measured again on CranL.
**Why:** the tick and lease pattern is already proven; pg-boss would be a second job store; a push, unlike an SMS, can be
merged on the phone, so a requeue after a definite failure is safe; a lease must outlive every attempt it covers, or
at-most-once turns an outage into lost messages; post-event uninstalls are normal and must not stall every tenant.
**Trade-offs:** a requeued message can show twice on a phone that ignores the collapse id; one instance sends about 300
to 500 pushes a second; a long outage ends with messages expiring into the center only.
**Measured (T-501 build, 2026-10-28, laptop, ADR-350 (10)):** fan-out of one event notice to 50,000 active members with 1.2 devices each (60,000 sends) in 19.5 s over 27 calls, the slowest 871 ms (gates 30 s and 1 s); claim plus ack of 200 with that queue present 85 ms median, 122 ms worst of 7 (gate 200 ms); the foreign keys on `push_send` stay; measured again on CranL before
NFR-004's load test.

## ADR-346 — Push text: fixed templates, an allowlist of public names, ids only in the payload
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501 plan; plan review 80 and re-review 88 folded;
Q-315). Specifies rule 3, SECURITY "Data protection" and Apple 4.5.4.
**Decision:** (1) Every kind has a fixed title and body in both languages (ux-araby, gender-neutral phrasing such as
«يمكنك استلامها قبل {date}», Western digits, the event's terminology tokens). (2) Placeholders are only the event's, a
quest's, a category's or a reward's name (frozen on the notice) and a date or time in the event's zone; never a person's
name or contact, an amount, a rank number, an answer, a ticket's text, a submission or a reason. (3) Names are cut to 40
units and pass T-409's name rule, else the template's nameless variant is sent. (4) A push is in the device's language;
the center renders the same template in the request's language; a kind with no template shows generic center text and
is not pushed. (5) The payload carries the notification id, the kind, the event id and the kind's reference ids,
nothing else; the app maps them to its own routes, so no server-sent link is ever opened.
**Why:** the text goes through Apple and Google, outside the Kingdom; a fixed template cannot leak what it never holds.
**Trade-offs:** pushes are generic ("Your submission was approved", no points); the detail is one tap away.

## ADR-347 — Who receives a push, what it may name, the four mutable topics, and no quiet hours
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501 plan; plan review 80 and re-review 88 folded;
Q-316). Specifies FR-1102, FR-1103, FR-1115, FR-1703 and the T-208 note; keeps ADR-065 and Q-287 (Dhia: no quiet
hours for any push).
**Decision:** (1) The player must be `active`, at fan-out and at the claim. (2) Event kinds go to `active` enrollments
only (not excluded); the join decision reaches `active` or `declined`; a help-desk answer needs no membership. When an
event notice names a quest, a category or a reward, a member who cannot see it gets no center row and no send, checked at fan-out and at the claim: a category by `sees_category` (its audience and, if hidden, revealed by
them), a quest by `member_sees_quest` (`member_event_quests`' visibility test: visible, opened, not closed, its
category seen), a reward by its audience. A personal notice names what the player already acted on and needs
`sees_category` only. (3) The
event's status now decides the audience: `draft` and `scheduled` reach rehearsal enrollments only (the "starting soon"
kind reaches real members and skips them); `live` and `ended` reach every active member; `archived` reaches no one. (4)
Topics: `announcements` (announcements, flash quests, boosts, polls, category opening, the hint), `rank`, `community`
(milestones), `reminders` (starting soon, streak, shop closing, sessions). **The topic belongs to the kind**: a kind
without one cannot be muted in the app, and a personal kind may carry one (T-503's `rank`, the streak reminder's
`reminders`); promotional kinds follow consent. (5) Mute stops the push only: the center row is still written, unread.
(6) Mutes are per player for all events; T-510 adds event defaults under them. (7) No quiet hours, no daily cap and no
per-event brake for any push (ADR-065, FR-1103, Q-287); promotional sends still pass through `promoSendTime('push',
...)`, the one place to change that. A runaway sender is limited at its own door (T-502).
**Why:** FR-1703 and the T-208 note; a hidden or targeted category's name must not reach a lock screen its audience
rule keeps it from; an ended event's members still need the shop-closing reminder; the center must hold every message;
Dhia answered the quiet-hours question.
**Trade-offs:** a muted topic still raises the unread count; a scheduled event's early joiners get only the "starting
soon" push during rehearsal; a member who reveals a category after its notice was sent never gets that row.

## ADR-348 — A promotional push needs the recorded consent and a device; its tap opens the center row with the opt-out
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501 plan; plan review 80 and re-review 88 folded;
Q-317). Specifies FR-1111, FR-1114, ADR-318 and ADR-331 for push.
**Decision:** (1) A promotional kind reaches only players in `promo_pool('push', ...)` (opted in on push now, an adult by
ADR-317), checked at fan-out and again at the claim; the OS permission alone is never consent. (2) Its center row shows
an opt-out action that opens Settings → Offers and notifications, and **a tap on a promotional push opens that center
row** (T-501f decides the screen it shows), so the opt-out is one tap from every promotional push. (3) Invitations
(T-501f): push when the player is opted in on push and has a pushable device, else SMS when opted in on SMS; one
message per player per campaign; the admin approves the push text with the SMS text; reading the center row marks the
recipient opened once.
**Why:** consent is the recorded state (T-407), not a phone setting; a push cannot carry a link, so the opt-out lives in
the app (Apple 4.5.4, FR-1114).
**Trade-offs:** a player opted in on both channels gets the free push, never the SMS, even when the push is silenced on
the phone.

## ADR-349 — The app asks after joining, reads its APNs environment, and routes taps itself
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501 plan; plan review 80 and re-review 88 folded;
Q-318). Specifies FR-1105, FR-1106, FR-1824, PD-08 and STORE_COMPLIANCE §3.
**Decision:** (1) After a successful join, with the permission undetermined, the app shows its explainer ("Get told
when flash quests drop") with Turn on and Not now; only Turn on shows the system prompt; Not now waits 30 days; never at
launch, never after the OS answered. (2) Nothing is paid or opened for granting it; a refused permission changes no
screen except Settings' "Notifications are off on this phone" with "Open phone settings". (3) The center (P16) is
`/notifications`; the T-407b offers screen moves to `/settings/notifications` and gains the topic switches; the bell
sits on Questify Home and Event Home; Profile → Notifications opens the center (T-312b). (4) A tap opens the route a
fixed shared table gives for the kind and marks that row read; an unknown kind and every promotional kind open the
center row. (5) Android channels per topic, `personal` and `offers` are created before the prompt; `personal` and
`offers` show no content on a locked screen (`lockscreenVisibility: PRIVATE`). (6) Registration at launch when granted
and on a token change, otherwise at most once a day; iOS tokens lower-cased; sign-out removes the device first. (7) The
APNs environment is read with `expo-application` (ADR-344 (5)): `development` → sandbox, anything else (including
`null`, which every App Store and TestFlight install answers) → production; only a physical device registers.
(8) The `enrollment` producer's `WHEN` filter (T-501d) covers `declined → active` and leaves out operators and
rehearsal accounts (plan § Review 2). New dependencies: `expo-notifications` (the native
device token and taps) and `expo-application` (the APNs environment).
**Why:** FR-1105's wording; Apple 4.5.4 and 5.1.1; a route table in the app means a payload can never open an
arbitrary link; internal builds use production APNs.
**Trade-offs:** two more native modules (a new development build); a player who taps Not now is asked again only after
30 days and a new join.

## ADR-350 — Where the T-501 build fills in the push plan
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501 build, `docs/plans/2026-10-28-t-501-push.md`;
code review 87 accepted every departure, (11) to (15) are its fold-ins; Q-319). Refines ADR-343 to ADR-348 where the
plan left a detail open or could not hold as written.
**Decision:** (1) `member_sees_quest` is `member_event_quests`' own listing rule (the category seen, the quest
`visible`, a flash quest shown by `flash_shown`) **plus** the window (opened, not closed): `member_event_quests` lists
an ordinary quest that has not opened or has closed, with its times, so "the same answer" is checked against its rows
filtered by their own `opens_at` and `closes_at`. (2) Android tokens are capped at **2,048** characters (the plan said
4,096): a btree entry of `UNIQUE (platform, token)` is limited to about 2.7 kB, and PostgreSQL's regular expressions
stop at 255 repetitions, so the length is a `char_length` check. FCM tokens are about 160 characters. (3) A
registration that changes the **environment** (not only the token) also sets `token_set_at` and clears the invalid
mark, so a late invalid answer from the old APNs host never marks the device again; queued sends move to the new target
in the same statement. (4) `PushResult`'s `requeue` carries `written` (a definite 5xx counts an attempt, a request never
written does not), and the worker races every attempt against its 10-second limit, so a provider that never answers is
a timeout (`unknown`) and no attempt outlives its lease. (5) Ambiguous invalid-token answers are acknowledged at the end
of their target's round, so the guard can still hold them; held, they are requeued with the attempt counted (a request
was written). (6) The provider settings (`APNS_*`, `FCM_SERVICE_ACCOUNT`), their all-or-none and key checks and the
startup token check stay with T-501b's clients, which read them (the plan's split table; its test list had named the
config check under T-501). T-501 runs the worker with no provider: it fans out, fills the center and settles, every push
expires unsent, and in production `push.provider_missing {platform}` is logged once per start for each platform.
(7) `notice_create` also inserts nothing for a missing once-only marker, a personal or promotional kind without a
player, an event kind with a player or without an event, and another organizer's event: no CHECK or foreign key a
producer's data can fail. (8) The per-member rules (`notice_membership_ok`, `notice_visible`, `notice_member_ok`,
`member_sees_quest`, `push_skip_reason`) are PL/pgSQL, not SQL: a PostgreSQL 17 SQL function with a `SET` clause is
planned again on every call, which made one fan-out call of 2,000 members take 3.5 s; the device rule is one inlinable
set (`push_live_devices`, no `SET`, tables schema-qualified, as `promo_pool`), joined by the plan and checked by
`push_pushable`. (9) The center is rendered in the request's `accept-language`, Arabic when absent; a kind with no
template is acknowledged `failed` (`no_template`) with no request; the worker's pool is 3 connections built from
`poolOptions`. (10) Timing (laptop, Docker PostgreSQL 17, `test/perf/push-timing.int`): fan-out of one event notice to 50,000 active members with 1.2 devices each (60,000 sends) in 19.5 s over 27 calls, the slowest 871 ms (gates 30 s and 1 s); claim plus ack of 200 with that queue present 85 ms median, 122 ms worst of 7 (gate 200 ms); the foreign keys on `push_send` stay; after the code review's fold-ins (`test/perf/push-timing.int`, by hand): fan-out
18.4 s, slowest call 794 ms; claim plus ack of 200 with 65,000 event rows queued 163 ms median, with 10,000 personal
notices queued 153 ms (200 heads); the heavy checks run by hand only, the default suite keeps cheap versions. (11) **No promotional center row without consent** (developer's decision at the
code review; refines ADR-348 (1)): the fan-out writes a promotional notice's center row only for a player in
`promo_pool('push')` now, so nothing promotional appears in the center without the opt-in; a consent withdrawn after
the fan-out skips the push at the claim and keeps the row. (12) The claim's loose scan stops after 200 notices per
target (`push_queue_heads`), as many as a round can use: with 10,000 personal notices queued it visits 200, not 10,000
(the review measured 550 ms a claim at 30,000 before, about 110 ms after). (13) Each device carries a `token_version`
(bumped with a new token or environment) and each send records it at lease time; an invalid answer marks the device
only while the versions match, so a registration that began before the claim and committed after it keeps its new
token (the time comparison of (3) could lose it for 7 days). The acknowledgement locks devices `FOR NO KEY UPDATE`, so it
never waits on the fan-out's `FOR KEY SHARE`. (14) A notice whose fan-out try fails waits out a back-off before the next
(`fan_failures`, `retry_after = now() + least(1 min · 4^(n−1), 1 h)`; the alert `push.notice_parked` at the third failure
in a row; the RUNBOOK's release is the manual override): the event batch runs in a block that undoes it alone and counts
the failure, a statement timeout included, so a poisoned notice no longer holds up the notices behind it, and a passing
error (a deadlock with a registration, a lock timeout) only delays it, never stops it for good (re-review 1: a permanent
park could be provoked by a member re-registering a token at the right moments). A failing personal batch of 500 is
undone and its oldest due notice tried alone, so a poisoned personal notice is found and backed off the same way and
never blocks the personal pass or the event notices behind it (re-review 3).
(15) The worker hands the provider a deadline 500 ms before its own timer (`PROVIDER_MARGIN_MS`), so a client giving up
at its deadline is heard as "never written" and not counted `unknown`; and `SYSTEM_CLOCK.wait` leaves no listener on its
signal (one `done` for the timer and the abort, registered `{ once: true }`): the worker reuses one signal for every idle
second of its life, and the leak measured 5.5 MB a 10,000 waits.
**Why:** each point keeps the plan's rule where the plan's literal wording could not hold (an index limit, a function
that lists unopened quests, a regex limit) or names what the plan left to the build.
**Trade-offs:** the visibility helpers are PL/pgSQL rather than plain SQL, so a wiring slice restating
`notice_audience_ok` keeps it plain SQL but these stay PL/pgSQL; an FCM token above 2,048 characters is refused (none
exists today); the config check lands one slice later than the plan's test list said.

## ADR-351 — Where the T-501b build fills in the provider clients
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501b build, `docs/plans/2026-10-28-t-501-push.md`
§ T-501b; core code review 88, every departure accepted, (11) and the corrections to (4) and (5) are its fold-ins; Q-320).
Refines ADR-344 and ADR-345 where the plan left a detail open or could not hold as written.
**Decision:** (1) **One HTTP/2 transport for both providers** (`src/push/h2.ts`, `node:http2`): FCM is posted over HTTP/2
too, not with `fetch` as ADR-344 (1) said, because only a stream's state tells "never written" (requeue, not counted)
from "written, then a timeout or a reset" (`unknown`, never resent); `fetch` reports both as one error. One session per
origin, reused, replaced after a `GOAWAY`, an error, a refused stream, a lost stream (11) or a hold; at most 50 streams in flight and never
above the server's `SETTINGS_MAX_CONCURRENT_STREAMS` (APNs allows one until a token is accepted); a request waits for a
stream until its deadline, and is written only with at least 200 ms left. (2) **"Never processed" counts as never
written:** `REFUSED_STREAM`, a stream above a `GOAWAY`'s last stream id, APNs 503 `Shutdown` and 400 `IdleTimeout`
answer `requeue` with `written: false` (no attempt counted, no in-lease retry, a new connection); a stream at or below
the last id of a `GOAWAY` with an error is `unknown`. These requeues still count towards the breaker (`send.ts`
unchanged), so a `GOAWAY` above many streams can hold the target for 30 s. (3) **A connection idle for 4 minutes is
closed** and the next send opens a fresh one, so a long quiet spell never writes into a path a NAT dropped (that write
would end as `unknown`); Apple asks to reuse connections, and a busy one is reused for as long as it lives. (4) **The
tables, completed by status:** any 410 removes the device (not ambiguous); any 403 holds (with `BadCertificate` and
`BadCertificateEnvironment`, which cannot occur with a token key); APNs 404 and 405 and any other 4xx are `failed` and
logged `push.apns_refused {target, status, code}` (a device's 429 `TooManyRequests` is not logged); FCM 401 and 403
hold, any other 4xx is `failed` and logged `push.fcm_refused {status, code}`; an FCM 429 holds for its Retry-After,
from 60 seconds up to 15 minutes. A 5xx is retried within the lease after 1 s and 2 s (ADR-345); Apple's own advice is to
retry a 5xx after 15 minutes, with back-off, so these early retries go against it, bounded only by the breaker (10
consecutive failures hold the target 30 s, doubling to 15 minutes) and the 8-attempt limit (Q-320). (5) **No `collapse_key` on FCM:** Google: "Notification
messages are always collapsible and will ignore the `collapse_key` parameter"; the Android `tag` (`n<notification id>`)
replaces the shown notification. A phone that was offline therefore gets only the latest push on both platforms: APNs
stores one notification per app while a device is away, and FCM notification messages always collapse. The in-app
center holds every message, so nothing is lost; the RUNBOOK go-live checklist checks this on real phones. (6) **Google's token endpoint:** a network failure, a timeout, a 5xx or a 429 is
"unreachable" (the send is requeued untried, no hold, the next send asks again); only a refusal (a 4xx such as
`invalid_grant`) holds `fcm` for 15 minutes and logs `push.fcm_auth_failed {status, code}`, once per hold. The startup
check asks for the first token in the background: a refusal holds as above, an unreachable Google is logged
(`code: unreachable`) without a hold (ADR-344 (4) said any failure holds). A 401 on a send drops only the token that was
refused and asks once more. (7) **The settings** (`config.ts`): the APNs key (PEM or its base64) must be an EC P-256
private key, the key and team ids 10 capital letters or digits, `APNS_TOPIC` a bundle id; `FCM_SERVICE_ACCOUNT` (JSON
or its base64) needs `project_id` (a Google Cloud project id: it goes into the request path), `client_email`, an RSA
`private_key` and an https `token_uri`. Both keys are kept as `KeyObject`s, which no log or inspect prints. Values come
from the environment only, as the plan says; no file-path setting is built. (8) **One APNs key for both hosts:** Apple
now issues keys limited to Sandbox or Production; the RUNBOOK asks for a key enabled for both. A key limited to one
environment answers 403 `BadEnvironmentKeyIdInToken` on the other host, which holds only that target (logged); separate
keys per environment are not built. (9) **The shared Google token code** is `src/auth/google-token.ts` (key-file
parsing and a token source shared by concurrent callers); the Gmail sender uses it with the same messages and tests.
(10) **Probed 2026-10-28 with self-made keys** (no Questify account exists): `api.push.apple.com` and
`api.sandbox.push.apple.com` answered 403 `InvalidProviderToken` over TLS and HTTP/2 in about 0.9 s (mapped to a hold),
Google's token endpoint 400 `invalid_grant` (hold and `push.fcm_auth_failed`), `fcm.googleapis.com` with a made-up
bearer 401 `UNAUTHENTICATED`. The transport and the error shapes are confirmed; a real key's acceptance, delivery to a
phone and the uninstall answers wait for the RUNBOOK checklist. (11) **A lost stream replaces the connection, and no
close waits on the far side** (code review MAJOR and minor): a path that silently stops carrying traffic (a NAT that
forgot the connection) made every send time out as `unknown` while the writes kept resetting the idle timer, so the
connection was never replaced; now any stream lost after its write retires the session, and the next request opens a new
one. A retired session's connection is dropped after 15 s (longer than any request's own 10 s), and `close()` drops it
after 2 s when the far side never answers the close, so a worker stop or SIGTERM never waits on a dead peer. The client
makes the connection itself (TLS with ALPN `h2` and the host's name, as Node's default) so it can drop the socket. Proved
with a TCP proxy that silently drops open connections, and by breaking each fix.
**Why:** each point keeps the plan's rule (requeue what never arrived, `unknown` only after a write, nothing sent
without valid keys, no secret in a log) where the plan's wording named a tool that could not tell the cases apart or
left an answer unmapped.
**Trade-offs:** an HTTP/2 client of our own (about 260 lines) instead of `fetch` for FCM; a quiet connection is
reopened after 4 minutes (one TLS handshake); a key limited to one Apple environment silently serves only that one
until the hold is read in the logs.

## ADR-352 — Where the T-501c build fills in the app's push
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501c build, `docs/plans/2026-10-28-t-501c-push-app.md`;
code review 84, MAJOR 1 and 2 fixed, (6) and (9) to (12) are its fold-ins; Q-321). Refines ADR-349 where the plan left a
detail open.
**Decision:** (1) **The explainer shows on the join result screens** (the join card and the invitation), the moment
the join went through, not on Event Home: Event Home already shows the location sheet after a join, and two sheets and
two system prompts would stack. "Open the event" then leads on to the location sheet as before. It shows only while the
system is unasked and "Not now" was not tapped in the last 30 days; the shade and the back button mean "Not now".
(2) **The route table names the kinds of the plan's owed-push table** (`join_accepted`, `flash_quest`, `reward_ready`,
`rank_top_ten`, …; `packages/shared/src/push/routes.ts`) as the contract for T-501d to T-501g, and a test requires every
kind with a template to appear in it, so a slice that adds or renames a kind changes its route in the same commit. A
promotion, an unknown kind and any id that fails its check open the center row. (3) **A tap's fields are read from
three places** (`trigger.payload.q` for direct APNs, `trigger.remoteMessage.data` and `content.data` for FCM), because
the library's source puts a direct-APNs custom key only in `trigger.payload`; the go-live checklist confirms it on phones.
(4) **Native access is one file** (`push-native.ts`): `expo-notifications` and `expo-application` are required only
after `requireOptionalNativeModule` found the native modules checked (a build holds all of a package's modules or
none, so a few stand for the set), so an older development build keeps working with push off; `isDevice` is read from the `ExpoDevice` native constant, not by loading `expo-device` a second time.
(5) **Mark all as read** on the center (the route exists, and a long unread list is otherwise 100 taps); the center's rows
carry `refs` (reference ids only) for the tap, added to the server schema as a separate commit. (6) **A resumed app reads
the unread count again** (`GET /v1/me/notifications?limit=1`, once per foreground; never the profile: a failed profile
read publishes `me: undefined` and the screens that need it, a game in progress offline at a venue, would unmount) so
the bell counts what arrived in the background or with no push at all; a push that arrives with the app open shows a
quiet banner and refreshes it the same way. (7) **Not set:** Android's
notification icon (a brand-deck asset) and `android.googleServicesFile` (Dhia's Firebase file); without the file Android
registers nothing and the center still works. (8) **The offers screen moved** to `/settings/notifications`
(`OffersSection`, now under the push status and the topic switches); `ChannelRow` became the shared `SwitchRow` (a third
user, the topics). (9) **A tap opens only once the launch screen has left** (`settleTap`): the launch screen's own
`router.replace` after its `/v1/me/events` read would otherwise land on the tap's screen and cancel it, which is the
common cold-start case. A tap held while the player signs out is dropped, so it never opens for the next account.
(10) **A registration records the player and the sign-in:** the record holds the player id, and a registration still on
its way when the sign-in ends (a chosen sign-out, or a session that ended on its own) is not recorded, so the next
sign-in never reads "already told" and misses its device row for up to a day. (11) **The explainer is not offered on an
Android build that cannot get a token** (no Firebase file); the Firebase file is a hard gate on the Android store build
(RUNBOOK, T-806's Done-when). (12) **Sign-out waits at most 3 seconds** for the device removal (the local record is
removed first, the call goes on without the wait); the center keeps the older pages already loaded when it reads the
newest page again on focus, when the new page overlaps them.
**Why:** each point keeps ADR-349's rules where the plan's wording could not hold or left a choice; none changes what a
player sees beyond the plan.
**Trade-offs:** the explainer appears before the player has seen Event Home; the route table names kinds before their
slices exist (a guard test keeps them consistent); a resumed app costs one small center read per foreground; a tap on a
cold start waits for the launch screen (a fraction of a second to one events read).

## ADR-353 — Where the T-501d build fills in the personal pushes
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501d build, `docs/plans/2026-10-28-t-501d-personal-pushes.md`;
code review 84, MAJOR 1 and 2 fixed, the minors folded; Q-322). Refines ADR-343, ADR-346 and ADR-347 for rows 1 to 6
of the T-501 plan's "Owed pushes".
**Decision:** (1) **The join-decision trigger also leaves out the player's own re-join**
(`app_player_id() IS DISTINCT FROM NEW.player_id` in its `WHEN`): `join_write` turns a declined or pending request
active when an invited player joins again, which is answered on screen and is not a decision; decide, accept-all and a
waiting-list release run in the team's seat and are pushed. (2) **Ready at the desk:** a due scan sends
`reward_ready` once per reservation, when the event's desk keeps hours, is open now, and the window open now began after
the reservation was made (it waited for this opening); none for a desk without hours (open all along) or a rehearsal
account (its reservations ignore the desk's hours). (3) **Ending:** `reward_ending` 15 minutes before `reserved_until`,
for a hold longer than 30 minutes counted from when it became collectable (the later of the reservation and the last
desk opening at or before its end), only while the desk is open at some moment before the end, never while the player
is collecting or was offered at the desk; it names the time, never a countdown. Both scans run in one system door,
`push_due()`, every 60 s from the push worker (switch on or off), 500 notices each a call. (4) **The help-desk answer
is three kinds** sharing the `requests` route (`help_answered` for the event team or its operators,
`help_answered_questify`, `help_solved` for either team's "solved"), because a template belongs to a kind; message keys
are `push.<kind in camel case>.body` and `.nameless` (the messages key rule has no underscore). (5) **`notice_create`
is restated in PL/pgSQL** (the same one insert and answers): PostgreSQL 17 plans a SQL function's body again at each
call from a trigger, which cost accept-all of 5,000 requests about 2 s; `push_names` (the frozen `{ar, en}` cut to 40)
has no SET clause and only pg_catalog functions, so it is inlined; `notice_create`'s parameters are qualified with
its name, so a later column named like one cannot make every producer raise. **Accept-all takes at most 1,000
requests a call on an event without a hard limit and 250 on a hard-limited one** (0077 restates
`accept_all_join_requests` with `LIMIT least(free, CASE WHEN free IS NULL THEN 1000 ELSE 250 END)`, nothing else
changed): under 5 s per call for an event without a hard limit (1,000 per call); 250 per call when there is a hard
limit, because its seat guard (`enrollment_player_limit`, 0036) recounts the event's seats on every accepted row (the
cap re-review measured one call of 1,000 there at 3.3 s with 5,000 pending and 9.4 s with 20,000 seated; T-221, Q-323,
checks the limit once a statement so the cap can go). The dashboard repeats while a call accepted some and requests
wait (at most 10 calls a press, a progress line, "press again" when the calls ran out with requests waiting; leaving
the page stops the calls; a call that fails partway keeps what the earlier calls accepted and says so). Measured on the laptop (by hand,
`test/perf/push-producers-timing.int`, 5,000 waiting): one call of 1,000 takes 1.70 s with the join-decision trigger
and 1.22 s without, a hard-limited event's 250 takes 0.85 s; the unbounded accept-all of 5,000 had taken 7.4 s with the trigger
and 5.8 s before it, over the API's 5 s statement limit (`57014`, nothing accepted): the review measured the ceiling
falling from about 4,300 to about 3,200 requests with the trigger, and 5 s of the 5.8 s is the souvenir enqueue trigger
(`souvenir_on_fact`, T-402b, about 1 ms a row). (6) **The acceptance says only that the request was accepted** ("You can play now" is false before the start, and a
scheduled private event is the usual place to accept). **The prize names its deadline's date and time** («حتى
{date}، الساعة {time}»): a deadline can fall on the reveal's own day. (7) **Rehearsal accounts** get their own
submission and help-desk answers during rehearsal (they are the organizer's testers, as T-501 sends them event pushes
before the start); never a join decision (they make no requests) or a reservation push; results need an ended event, so
they never win a prize.
**Why:** each point keeps the plan's rules (one insert per notice through `notice_create`, statement triggers for bulk
writes, the row trigger on `enrollment`, due scans for moments, no `EXCEPTION` block, a broken kind never undoing a
door) where its wording left a choice or a number open.
**Trade-offs:** a ready push can arrive up to a minute after the opening and an ending push up to a minute late; a
reservation that spans several desk openings is told it is ready only once; the help desk's three kinds mean three rows
in `notice_kind` for one route; accepting more than 1,000 requests takes several calls, which the dashboard makes
for the organizer.

## ADR-354 — Where the T-501e build fills in the event pushes
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501e build and code review 78, its BLOCKER and every
finding folded; `docs/plans/2026-10-28-t-501e-event-pushes.md`; Q-324). Refines ADR-346, ADR-347 and ADR-350 (8) for
rows 7 to 12 of the T-501 plan's "Owed pushes".
**Decision:** (1) **A live or ended event's notices reach real members only:** `notice_status_ok` is restated so a
rehearsal account left between go-live and the wipe gets no event push (the plan's table said "every active enrollment";
`polls_shown` and `boost_in_force` already keep rehearsal play apart from live play). Draft and scheduled stay
rehearsal-only, archived nothing. (2) **Every T-501e kind skips a member who may not play** (an operator the owner keeps
from playing, `staff_assignment.can_play` false, FR-906): all six are about playing. (3) **Producers:** a row trigger on
`quest` for Launch (`flash_launched_at` set) and Send (`poll_sent_at` set), a row trigger on `boost` for a boost saved
to start at once (the plan's "at once"), a statement trigger on `community_reach`, and four due scans in `push_due()`
(every 60 s, 500 notices each a call): a scheduled flash quest's opening, a boost's later start, a category's opening
and a scheduled event's start within the hour. The markers carry the moment where it can change or repeat:
`flash:{quest}:{opens_at}`, `poll:{quest}:{sent}` (a rehearsal send and the live send are two notices),
`category_open:{category}:{opens_at}`, `event_soon:{event}:{starts_at}` (microseconds since the epoch); `boost:{id}` and
`community_step:{step}` once. (4) **Re-checks at sending:** a flash quest ended or moved and a poll closed fail
`member_sees_quest`; a poll voted, a boost stopped, a flash quest's, a boost's or an opening's category not opened yet
(moved later: code review 3, `push_category_opened`), an opening's category given a gate, and an event whose start moved
(its marker no longer names the start) fail `notice_audience_ok`. (5) **The per-member checks keep their plans.** A SQL
function with a `SET` clause called from inside another function's query is planned again at every call, with every such
function nested in it: `sees_category` planned `in_audience` again for each member, so the T-501 visibility check cost
about 3 to 9 ms a member and a live poll's fan-out to 50,000 members took 336 s (one call of 2,000 up to 14.8 s, over
the API's 5 s statement limit, so the notice would have backed off for ever). `sees_category`, `flash_shown`,
`member_sees_quest`, `notice_visible` and `notice_reward_seen` are restated in PL/pgSQL with the same rules (calling
such functions only in plain expressions, whose state lasts the transaction), and `notice_audience_ok` becomes PL/pgSQL
(ADR-350 (8) had it plain SQL); every reader of the first two gains the same speed; the code review proved the six
identical to the old ones over 8,310 member × quest and 7,252 notice × member pairs. `docs/rules.md` states the rule.
(6) **The community push is one per goal per settle, for the highest step it reached**, and names no quest: a goal's
title is not on the name allowlist and a points goal counts none; it reaches every member who may play while the event's
community switch is on (the community card's own audience); its tap opens Event Home, where the community bar is (the
route table said the quests tab). (7) **A category's opening** is pushed only when it opens after the event's start (one
open from the start is the start's news), within 2 hours of the opening, while the event is live, with a visible quest
in it and no community lock, **and never for a category that unlocks after another one** (code review BLOCKER): each
member's real opening is when they clear its gate, which no push announces, and checking the gate per member ran
`category_cleared`'s nested SQL functions per quest (one call of 2,000 about 5 s, 35 ms a cleared member at the claim).
The fan-out and the claim check only that the category has opened and has no gate; its recipients see the category. (8)
**Texts** (ux-araby pass): no adjective or verb agrees with the event's word for a quest, which an organizer may make
masculine or feminine; `{questMany}` is a non-human plural. (9) **The event fan-out takes 1,000 enrollments a call**
(`push_fan_out_batch` restated; 2,000 before, code review MAJOR): a push that names a quest checks more per member, and
a call stays near half a second. (10) **A moved start or opening is pushed again only when it moved 15 minutes or more
from every earlier push of it, and at most twice** (the event's start per event, either way; an opening per category,
only to a later time: one corrected to an earlier time is already open and was told; `push_repush_ok`, which leaves a
marker in another format out), so an organizer nudging the start never pushes every member each minute; a smaller nudge
gets no push, and the old push's queued sends are skipped at the claim (never a wrong time). (11) **A flash quest or a
boost waits for its category** (re-review 1): while the category has not opened (or, for a boost, is held by a community
lock) the trigger and the scans write nothing and leave the marker free, and the due scan pushes it once the category
opens while the quest or the boost still runs; the flash scan covers launched quests too for that case.
**Measured** (laptop, `test/perf/push-event-timing.int`, by hand, 50,000 members with 1.2 devices each): a live poll in
30.0 to 30.2 s over 52 calls of 1,000, median 0.60 s, slowest 0.68 s (with calls of 2,000 it had been 25.7 to 28.6 s,
about 1.1 s a call); the hard gates are 1 s a fan-out call and the API's 5 s statement limit; the whole under 30 s is a
soft target, since the worker runs one fan-out call and then one claim of 200 per pass, so the claim rate sets when the
last member is pushed; measured again on CranL before NFR-004's load test; a category's opening 27.3 s, median 0.55 s;
the claim plus ack of 200 about 0.1 s with 60,000 sends queued, 73 ms median after a 20-quest gate was set on the
opening's category (every row skipped, no gate check); an opening notice of a gated category 0.15 s a call writing
nothing.
**Why:** each point keeps the plan's rules (one insert per notice through `notice_create`, row triggers for single-row
doors, a statement trigger for the tick's bulk write, due scans for moments, no `EXCEPTION` block, a broken kind never
undoing a door, visibility checked at fan-out and at the claim, the T-501 fan-out budget) where its wording left a
choice open.
**Trade-offs:** a scheduled moment's push can arrive up to a minute late; a jump past several milestones is one push; an
operator kept from playing learns of flash quests and openings in the dashboard, not by push; a gated category's opening
is never pushed, and a flash quest or a boost in a gated category reaches members who have not cleared the gate yet (a
per-member gate check is the slow path the code review's BLOCKER removed; developer's decision at the re-review); a
start nudged by less than 15 minutes is not pushed again and its old queued pushes are dropped; calls of 1,000 add about
2 s to a 50,000-member fan-out; two shared readers (`sees_category`, `flash_shown`) change language, so a later
restatement must keep them PL/pgSQL or inlinable.

## ADR-355 — Lean coordinator rules: three tiers, one review, batched follow-ups
**Status:** Accepted (Dhia, 2026-10-28; asked with AskUserQuestion after he saw the session's cost). Amends the coordinator-mode section of `CLAUDE.md` (items 1 to 3, new item 8) and ADR-174.
**Decision:**
1. **Three tiers.** Tier A (ledger, sign-in, tenant isolation, redemptions and prize handover, admin powers, wallet signing, signed proofs, code that stores or sends personal data outside): plan, plan review, build, one code review, mutation. Tier B (everything else with logic, including push producers, pages and standard routes): a mid-tier build and one mid-tier code review, no plan review, no mutation. Tier C (docs, copy, config, small fixes): no review.
2. **Findings.** BLOCKER and MAJOR are fixed now. MINOR and NIT go to `docs/FOLLOWUPS.md` and are cleared in one cheap batch about every five tasks. Re-review only after a BLOCKER, and only the changed part.
3. **No resuming of large workers** (about 200k tokens or more). Fixes after a review go to a fresh Sonnet worker given only the findings and the files, or the coordinator makes a one- or two-line fix.
4. **Mutation** only for ledger, sign-in, tenant isolation and redemption code, one run per three tier A tasks, one chase round at most; equivalent survivors are noted, not killed.
5. **Cost is visible.** Each task's STATE bullet carries its CI minutes and a rough agent-token figure. The full suite runs once per task. No slices unless each delivers value alone. A finding that repeats becomes an automatic check or a `docs/rules.md` line.
**Why:** the 2026-10-27/28 session used on the order of 20 million agent tokens by the tools' own counts (they include re-read context, so fresh spend was lower) and many hours for roughly 12 tasks. Each core task took 6 to 10 agent sessions; large workers were resumed for small fixes; minors and nits were folded one by one with a full-suite run each; mutation ran after every task. The reviews found real defects, but almost all in SQL, locking, timing, outside calls and consent, so review effort belongs there.
**Trade-offs:** minors wait for a batch; tier B code sees one mid-tier review and CI instead of two Opus reviews and mutation, so a subtle defect there is more likely to surface late. The pre-push checks (`pnpm lint:limits`, `pnpm audit`, gitleaks, CI) stay for every task.

## ADR-356 — Where the T-501f build fills in reminders and promotion by push
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501f build and tier A code review, its MAJOR and
MINOR findings folded; `docs/plans/2026-10-28-t-501f-reminders-promotion.md`; Q-325). Refines ADR-331, ADR-338 (6), ADR-347 and ADR-350 (11) for rows 13 to 16 of the T-501 plan's "Owed pushes".
**Decision:** (1) **Three kinds** (migration 0079): `streak_reminder` (personal, topic `reminders`, no event, 6 hours,
until midnight Riyadh), `shop_closing` (event, `reminders`, active members, 24 hours, until the close) and `invitation`
(promotional, no topic, no enrollment needed, 7 days, until the event's end). The daily games reminder is folded into
the streak reminder: one daily reminder at most, whose text ("playing today") covers a quest, the daily challenge and
the daily word. (2) **The streak reminder** is a due scan from 18:00 to midnight Riyadh while the daily streak switch is
on, once a Questify day per player, for an active player with streak days yesterday and the day before and none today;
**only a player with a pushable device who has not muted `reminders` gets one** (a reminder that cannot be pushed writes
no center row, unlike other kinds: the center keeps messages, and a reminder is only useful as a push); at the claim, a
player who has played since is skipped. The text names nothing (no number, no countdown, no loss: ADR-300). (3) **The
shop's closing** is a due scan once the event has ended, its shop is open by `shop_state` and switched on (the event's
and the platform's switch), and the close is within 24 hours; once per event; to real active members with a balance
above 0 (not an operator kept from playing); the notice freezes the closing date, and a window extended after it is
skipped at the fan-out and the claim with no second push. (4) **Invitations by push:** `invitation_campaign.channels`
takes `{push, sms}`; the fill gives each chosen player one row and one channel, push when the campaign has push and the
player is opted in on push (`promo_pool`) with a pushable device, else SMS when the campaign has SMS and the player is
opted in on SMS, never both and no fallback; the phone's permission alone is never consent. The invitation tick's
hand-off door (`invitation_push_hand`, system seat, 500 rows a call, the claim's campaign locks, and only while the
invitation switch and the platform push switch are both on: with either off the rows stay queued, as SMS rows do in a
hold) re-checks consent and membership, writes one notice per row through `notice_create` and marks the row `sent` (handed to the push store; the
fan-out and the claim check consent again, with no center row without it); a row whose notice could not be written (a
broken kind) is `failed` (`no_kind`). Push is offered at approval only when both push providers are set up (a player
on a platform without its provider would get neither the push nor the SMS); the estimate
before approval counts both channels; quiet hours stay SMS's alone (Q-287), so the send time moves only when SMS is
among the channels. The console shows the push text beside the SMS. (5) **The open:** opening the invitation's center
row (a tap on the push or on the row, which marks that row read by id) marks the recipient's `opened_at` once and
counts it, while the event runs and the results are open; "mark all as read" counts no open. The rows named are
counted after their campaigns are locked in id order in one statement (`docs/rules.md`). (6) **FR-1114's screen:**
a promotional tap opens the notification center on that row, highlighted, with its opt-out to Settings → Offers and
notifications; an invitation row also carries "See the event", the join screen by the event's public code (frozen on
the notice, `via: link`). No separate detail screen. (7) **The claim asks each kind's own audience rule for every
notice** (`push_skip_reason` restated): personal and promotional kinds now have one too (a streak played since, an
invitation's player who joined meanwhile, or whose event no longer takes an invitation by `invitation_event_ok`, as
the SMS claim asks at every claim); T-501d's kinds pass as before. The invitation tick hands push rows over in a step
of its own (`invitation.hand_failed`), so a failed hand-off does not skip that tick's SMS.
**Why:** each point keeps the plan's rules (one insert per notice through `notice_create`, due scans for moments, no
`EXCEPTION` block, a broken kind never undoing a door, consent from `promo_pool` at every step) where its wording left a
choice open; the reminder's device filter keeps a daily kind from writing a center row a day for every streaking
player who cannot be reached; a fixed channel per row keeps "never both" provable.
**Trade-offs:** a player without push loses no reminder in the center (there is none); a muted reminder leaves no trace;
an invitation row counts as sent once it is handed to the push store, even if the push is later skipped (consent
withdrawn, device gone); a player who loses their device between the fill and the hand-off gets the invitation in the
center only; a shop window extended after the notice gets no reminder at all; the estimate before approval may count
SMS-only players for a push-only campaign.

## ADR-357 — Where the T-501g build fills in the hidden-category hint push
**Status:** Accepted (developer, delegated by Dhia, 2026-10-28; T-501g tier B code review: one MAJOR fixed, minors folded;
`docs/plans/2026-10-28-t-501g-hint-push.md`; Q-326). Refines ADR-200 (FR-238 moved to T-501), ADR-204 (hidden categories),
ADR-343, ADR-347 (2) and ADR-354 for row 17 of the T-501 plan's "Owed pushes".
**Decision:** (1) **One kind** (migration 0080): `category_hint` (event class, topic `announcements`, active members, 2
hours, not `before_start`; the placeholder route `hint` is replaced by `category_hint`). Its producer is the team's door
`send_category_hint(event, category, press, request)` (definer, granted to the API role), which calls only
`notice_create`: refs the category's id, params the event's name, marker `hint:{category}:{sha256 of the Idempotency-Key}`.
**Once per press:** the same key finds its notice and answers `replayed` (no second notice, no new reveal); a different
press while a hint of the category is still being delivered (a notice of the last 10 minutes whose fan-out is not done) is
refused `409 hint_in_progress`, so a double click with two keys cannot send twice. A press that would tell no one (the
count is 0: nobody has joined, or everyone it reaches was told) is refused `409 hint_nobody` (`PT409`), checked after the
replay, so a resent key still answers `replayed`. A missing kind row writes nothing, the
door commits and answers `sent` false (the API: `503 hint_unavailable`, logged `push.hint_not_written`). Audited
`category.hint_send` (no recipients: unknown until the fan-out ends). (2) **The reveal is the fan-out's work, not the
producer's:** `push_fan_out_batch` (restated) gets a data-modifying CTE that writes a `category_reveal` row for each
member of the batch who gets a center row, in the same statement, so recipients and the players who see the category are
one set by construction, and the producer still calls only `notice_create`. The reveal never waits on a device, a
permission, a mute, the platform switch or a delivery: a player with push refused or `announcements` muted still gets the
center row and the category, and a send that fails or is skipped at the claim does not take it back. `notice_visible`
waives `sees_category` for this one kind (the hint is the grant); the category must still be the event's. (3) **Who is a
recipient** (`push_hint_ok`, inside `notice_audience_ok`, asked at the fan-out and again at the claim): the membership and
status rules of every event kind (an active enrollment of an active player; real members on a live event, rehearsal
accounts on a draft or scheduled one; not an operator the owner keeps from playing), and **joined at or before the press**
(`enrollment.joined_at <= notice.created_at`, which every join, acceptance and re-join sets to now), the category still
hidden and the member in its audience (`in_audience`), and **not told by an earlier hint of the category since they
joined**: a second press reaches only members not yet told. A player who joins after the press sees the category only by
scanning its secret code. Members who already found the category by its code are told too (the hint is a broadcast).
(4) **The text** names only the event («في {event} شيء جديد مخفي.» / "Something new is hidden in {event}."; nameless:
«في الفعالية شيء جديد مخفي.» / "Something new is hidden in this event."): never the category's name, which is the
secret and goes to Apple and Google. Route: the quests tab. (5) **The dashboard:** a hidden category's card gets "Send a
hint" (owners and editors within their event limit through `award_event_of`, live events and open rehearsals only, never
an ended event). `GET …/categories/{id}/hint` answers the count `{members, pending}` (`category_hint_preview`, STABLE),
the dialog says "N of your players will be told", `POST` sends it with an Idempotency-Key made when the dialog opens. The
count is one set-based statement over the same rules (the exclusion list as a `NOT EXISTS` with `excluded_from_event`'s
test written out, because that SQL function holds a sub-select and is never inlined: asked per row it took 2.4 s at
50,000 members as soon as the event had one entry; a tag audience found from the guest list's side), with a database
test that it equals the recipients on a crowd holding every excluded kind (a phone and an email domain among them) and on
each audience rule; an audience kind it does not know falls back to `in_audience` per member. The door runs the same
count and refuses a press when it is 0.
(6) **Cost at 50,000 members** (by hand, `test/perf/push-hint-timing.int`, 2026-10-28, two runs): the count 363 to 366 ms
with no exclusion entry and 305 to 337 ms with one that matches nobody (the first version, asking `excluded_from_event`
per row, took 2,367 ms with that entry), 228 to 241 ms with a tag audience of 10,000 guests; the press 311 to 327 ms (it
counts first, 22 ms before); the fan-out, with the exclusion entry in place, 41.2 s in 102 calls of 500 enrollments (median
409 to 411 ms, slowest 465 to 474 ms; 39.9 s and median 392 ms in the first measurement, so the entry does not slow it:
the fan-out's membership rule, 0076, calls `excluded_from_event` for every member whatever the list holds, and that cost is
in the figure). A hint batch is 500 because its reveals and per-member rules cost about a third more, as ADR-354 (9) cut
the event batch to 1,000;
the generic event fan-out is unchanged (a live poll 31.0 s, median 628 ms; an opening 27.3 s, median 541 ms, against
30.9 s and 26.9 s before). The hard gates hold (each call under 1 s and the API's 5 s limit); 40 s is over the 30 s soft
target, so the last members get the category about 40 s after the press.
**Why:** a hint that revealed at press time would need a 50,000-row insert in the door's own statement (over the 5 s
limit) and would reveal even when no notice could be written; revealing in the fan-out makes the center row and the
reveal one write and keeps the door to one insert. Naming the category would hand its name to every vendor and defeat
the hiding. The joined-at cut-off is what makes "players who joined after the hint do not see it" true when the fan-out
runs seconds after the press.
**Trade-offs:** while the worker is down the hint reveals nothing (the fan-out is the reveal); a player erased between
the batch's read and its reveal insert fails that batch once and it runs again after the back-off; an organizer who
un-hides the category before the fan-out tells nobody; an earlier hint's center row purged by retention lets a member be
told again; the placeholder kind name `hint` is gone from `NOTIFICATION_TARGETS`.

## ADR-358 — Bilingual announcements on the push store and Home (2026-10-29)

**Status:** Accepted (developer, delegated by Dhia, 2026-10-29). **Question:** Q-327.
**Context:** T-502, FR-806, FR-807, FR-1107 and FR-1108; approved scope:
docs/plans/2026-10-28-t-502-announcements.md.
**Proposal:** (1) Migration 0081 stores immutable bilingual title (60 code points), full body (500), and 140-code-point
push/center body, state, send time, author and hashed event-local idempotency key. Invisible characters are removed,
whitespace folded, digits made Western, and all four fields filtered by T-409's name rule. This is an explicit,
bounded exception to fixed-template-only push copy: authenticated organizer text may name no address or phone number;
audit/errors contain ids/field names, never text. Rendering checks the frozen title/body again: invalid text gives
generic center text and no push. (2) One event-kind notice on topic announcements, two-hour TTL, announcement id ref,
routes to event Home. Existing membership, rehearsal, exclusion, mute and claim rules apply; preview counts the same
eligible members in a set-based query. Operators barred from playing still receive event announcements. No channel
field or email/SMS sender. (3) The door serializes per event, replays first, and reserves at most 3 sends in any rolling
hour and 10 in any rolling day, scheduled sends included. Cancelled/skipped reservations release the slot. No new API
bucket. (4) Schedule 2 minutes to 180 days ahead, inside event start/end; the minute tick locks due rows SKIP LOCKED and
rechecks phase and lateness. Ended/archived, not-live and over-30-minute-late rows are skipped and audited; missing kind
waits for the next tick. Cancel locks the same row. Send-now with no audience or without a live event/open rehearsal
is refused. (5) Dashboard offers counters, cleaned bilingual previews, recipient count, event-zone time, confirmation,
all four states and cancellation. Delivered counts are exact below 10 then rounded to tens; Sending lasts until fan-out
finishes. Mutations reauthorize event scope before cached idempotent replay. Transient failures retain the same key
and frozen confirmation payload. (6) Home shows three announcements, See all up to 50. Happening now reads ongoing
flash/boost windows from Quests, not the live feed's 15-minute tail. Categories remain Quests; polls/community retain
existing Home cards; sessions remain T-505. This explicitly clarifies FR-806 presentation, not a silent requirement
deletion. (7) At 50,000 members with devices and an exclusion entry: count 732 ms, press 337 ms; fan-out 19.235 s across
52 calls, slowest 430 ms. Both 1 s call and 5 s statement gates pass (local 2026-10-29).
**Trade-offs:** spelled-out addresses can pass; authenticated staff are the copy trust boundary. Scheduled audience may
differ from preview. Announcement history remains until event deletion (event-data retention Q-075 still applies);
notice purge removes its delivered count. No dependency or remote code/config.
**Review and decision:** Independent tier B review scored 84, with two MAJORs reproduced and fixed in efad9cd:
send reauthorizes and rereads after advisory/event locks, holding the event FOR SHARE through the write; due-send
locks event before announcement. Pending schedules use earliest-first keyset pages of 30, separate from the newest
30 history rows, so every pending schedule remains reachable for cancellation. Regression evidence: 703 targeted
tests and 199 browser tests passed (one existing skip). Coordinator inspected both fixes; no BLOCKER required a
re-review under ADR-355. Accept all seven choices above, explicitly including the flash/boost-only strip with existing
poll/community cards beside it. The modal-accessibility MINOR remains in FOLLOWUPS. Remote CI and the existing
provider/real-phone checks remain gates; acceptance does not authorize deployment.

## ADR-359 — T-503 ordered durable top-ten transitions and coherent publication

**Status:** Superseded by ADR-362 (2026-10-29).
**Recommendation:** preserve FR-613 without coalescing: serialize same-event source transactions, maintain an
eligible-only indexed projection and persist every committed top-ten crossing with source changes, ordered event
revision and lifecycle generation. Durable inbox carries transition facts, not final-state ids-only dirty signals.
All overall publications, including afterCompletion place, board/own/total live reads, fallback and repairs, must
use one coherent PostgreSQL boundary; remove overall Redis authority, preserve today-cache and existing API/
canonical eligibility/order/own-rank semantics. This avoids a Redis/DB distributed publication protocol and partial
incremental boards. A published 11->9->11 between drains has both durable facts. No requirement relaxation.
Source-time generation/reset edges and silent baseline cover off->on, lifecycle clock transitions and rehearsal;
exact latest transition identity AND generation gates fan-out and claim, including delayed entry1 after entry3.
Both entry/exit rank-topic kinds, five-minute TTL, revision/generation dedupe, eligible score-zero exit, safe fixed
bilingual text and ineligible-recipient suppression remain. Retain captured-id-only deletion and Redis independence.
**Lock/cost trade-off:** explicit shared/exclusive global pre-lock G and sorted per-event E locks before legacy
locks; eligible projection gives indexed top-ten selection even with excluded leaders, not an attendee scan per
completion. Global eligibility/bulk/erasure pauses and exact own-place read cost are real. At 333.34 writes/s in one
hot event, average serialized E hold must be <3 ms (target <=1.5 ms); benchmark full transaction hold/queue/latency,
50,000 members and worst excluded leaders before declaring feasibility. Failure requires coordinator redesign,
never coalescing. More source-door changes than the rejected worker-only detector, but preserves the requirement.
**Coordinator decision:** inspected the amended publication inventory against ranking.ts, token boundary against
google-token.ts, the source writer/lock matrix and NFR-003 load requirement. Accept ordered transaction facts,
DB-authoritative overall publication, preserved today semantics and source-time generations; reject coalescing.
Authorize a performance-first implementation, not a feasibility or completion claim. First prove the representative
full completion path, exact crossing history, reset/stale gates and G/E transaction hold/queue behavior against
50,000 members and the per-event launch budget; stop for coordinator redesign if a gate fails. Exhaustive writer
coverage, canonical projection equivalence and deterministic both-order lock tests remain mandatory before code
review/push. No arbitrary excluded source, legacy-lock inversion, requirement waiver or unmeasured success claim.
Review80 MAJOR-only corrections need no independent re-review (ADR-355); independent Tier A CODE review is owed.
Full resolution map/tests: `plans/2026-10-29-t-503-rank-organizer-alerts.md`.

## ADR-360 — T-503 self-service organizer alert mail and safe dispatch

**Status:** Accepted design (developer, delegated by Dhia, 2026-10-29; Q-329). Implementation proof gates remain.
**Recommendation:** retain seven own-member operational preference defaults ON, but **operational transport OFF**.
Source-time eligible staff ids/membership generation plus final scope/staff/opt-out reauthorization; no backfill,
addresses or mail content in outbox. Threshold <= max(1, ceil(total * 10%)), recovery episodes, no rearm merely
because total/threshold revision changed; genuine cap revision/80/100 semantics. Physical/code counter/threshold
revision examples and exhaustive source writers are inventoried in the amended plan. T-609 reuses infrastructure;
T-701 supplies future general unpublish/support sources, not invented player moderation.
Use explicit source writer G/E matrix, including membership deletion/scope/staff-disable/bulk/lifecycle/erasure,
with final marker commit before network as authorization linearization. Prove both conflict orders with two DB
connections and deterministic barriers, no sleeps. Later revocation cannot recall already-authorized handoff.
Gmail token source `auth/google-token.ts` needs per-waiter abort isolation: an aborted operational waiter never
sends after shared token resolution, and cannot abort unrelated auth callers. Whole-attempt and send cancellation
are bounded, but send abort/timeout is not evidence of nonacceptance. Separate structured provider-specific
accepted/proven_refusal/uncertain outcomes from conflated EmailSendError; never parse messages. Conservative send
retry allowlist starts empty except explicit documented/tested provider refusal rules; no uncertain resend/failover,
no auth failover behavior change. Commit dispatch_started before token/send network; crashed started work stays
uncertain, unique delivery keys do not promise external exactly-once. Membership generations and contact suppression
remain. Real mail OFF until Saudi transport or explicit counsel-approved foreign-transfer extension, not ADR-112's
auth exception. No new dependency/account, arbitrary recipient or duplicate sender/store/switch UI.
**Gate/trade-off:** at-most-once uncertain attempts can lose mail. Coordinator accepts the amended technical defaults
with an EMPTY automatic send-retry allowlist until each provider-specific refusal has explicit documented/tested
nonacceptance proof. No message parsing or timeout-based retry classification. Source guard coverage, isolated token
wait cancellation and both-order authorization tests remain implementation gates. Real transport stays OFF; approval
authorizes local fake implementation only, after the early ranking feasibility gate. All seven review findings map
to concrete corrections/tests in `plans/2026-10-29-t-503-rank-organizer-alerts.md`.

## ADR-361 - T-503 full-source event lock feasibility failure

**Status:** Superseded by ADR-362 (2026-10-29).
**Evidence:** `evidence/2026-10-29-t503-early-gate.md` and JSON. On the recorded 50,000-member local
setup, the actual complete_quest/ledger/bonus/trigger transaction under ADR-359's shared G/exclusive E
has warm mean E-residence LOWER bounds 14.46488 and 14.20142 ms. Actual mean hold is longer;
<3 ms hard gate / <=1.5 ms target fail. Confirmation client mean 20.262509 ms bounds full hold above.
The optimistic arithmetic upper capacity is 4,224.93/minute, not a measured sustained-rate claim.
No candidate production migration or cache-authority cutover was activated; 0082 remains free.
**Recommendation:** stop implementation before email/UI. Profile/optimize the full source chain, not only
indexed top selection. If insufficient, investigate a short terminal publication fence after business
lock acquisition, with no legacy/source lock acquisition after E, all ordered facts committed atomically
and a proven visibility/lock graph. This changes ADR-359's E-before-legacy protocol and needs explicit
coordinator acceptance, full writer/cascade/default inventory and both-order proof before implementation.
The test-only probe does not guard all writers or implement resets/drain/claim/publication cutover.
Never fix the failed gate with coalescing, missing crossings, relaxed eligibility or an NFR-003 waiver.
Existing accepted product semantics, OFF transport and empty send-retry allowlist remain unchanged.
**Coordinator direction after 9b1e76e:** the measured full-source E protocol fails; do not continue production work.
Authorize local TEST-ONLY source profiling and a distinct terminal-fence experiment, retaining the original red probe
and measurements. Early G remains mandatory; candidate E may be taken only after all business/legacy lock work,
with fresh post-wait READ COMMITTED snapshots and atomic finalization/commit. This is an investigation hypothesis,
not approval to move a lock in production or a claim of performance/correctness. Prove same-event concurrent
crossings, rollback/late commit, lifecycle/global conflicts, deferred FK/trigger back-edges and actual fence-release
timing. A helper-query microbenchmark cannot pass the real-source gate. Report evidence for coordinator selection;
no new migration/adapter, email/UI, task tick, deployment, EAS or requirement/budget waiver.
**Second candidate result (56437ac):** reject explicit caller-driven terminal publication: a real completion can
commit while revision remains 355, and late nested/deferred business work can wait on legacy locks after E.
Mean release upper bounds 3.388-3.851 ms do not prove <3 ms. No production protocol is accepted.
**Next bounded experiment:** test automatic mandatory transaction-level deferred finalization, not another optional
publish helper. Drain existing deferred business work before sorted E acquisition; prove that subsequent source
entry/DML cannot acquire business locks after finalization, including nested payers and multiple events. Finalizer
failure must roll back completion, projection, snapshot and facts together. Probe transaction COMMIT and a following
server timestamp in the same backend request, retaining honest lower/upper bounds and the original measurement;
remove avoidable client round trips, not fsync or durability. Check actual crossing as well as noncrossing work.
Test-only authorization, one candidate with repeated bounded measurements; report FAIL/UNPROVEN if either invariant
or the unchanged load gate is unproved. No broad email/UI or repeated open-ended optimization loop.

## ADR-362 - T-503 reset: rank pushes from a periodic top-ten diff, off the completion path

**Status:** Accepted (developer, delegated by Dhia, 2026-10-29; Q-331). Supersedes ADR-359 and ADR-361; narrows
ADR-360.
**Why:** ADR-359 added a rule FR-613 does not have, "never coalesce: a published 11->9->11 between reads sends both
pushes", and paid for it with a global and per-event lock inside every quest completion. Three probes (9b1e76e,
56437ac, 61b5368) showed it cannot meet the NFR-003 completion budget (E held 14 ms or more against 3 ms). FR-613 says
"when the ranking updates"; a push a few seconds late, or no push for a blip that reverses within seconds, meets it
and spares players spam. A push producer is tier B (CLAUDE.md, ADR-355); the email sender stays tier A.
**Decision:** no change to the completion transaction or the ranking cache. A tick (the existing ranking tick or a
sibling, lease-guarded) reads each live event's current overall top ten from PostgreSQL with the board's own eligibility and order (ADR-363), compares it
with the stored previous top ten (`rank_top_snapshot`, one row per event), writes the new set, and creates one
personal `rank` notice through `notice_create` per entry and per exit. Eligibility, rehearsal and excluded players
follow the board as it is read. The first read of an event, a re-activation and a rehearsal wipe store a baseline
with no notices. One rank push per member per event per 10 minutes at most (a blip is dropped, not queued). Text:
fixed bilingual, no rank number (ADR-346). Organizer alerts (FR-1727): per-member switches for the seven types,
producers write an outbox row, the sender re-checks membership and switch at send time, transport stays OFF (ADR-360
transfer rule), uncertain sends are not retried. ADR-360's G/E source-lock matrix is dropped with ADR-359.
**Cost:** rank pushes may arrive one tick late, and a crossing that reverses before the next tick sends nothing.
**Cleanup:** the opt-in probe tests and SQL (`apps/api/test/db/t503-*`, `apps/api/test/support/t503-*`) are deleted;
the evidence files stay as the record.

## ADR-363 - T-503 build choices: rank diff reads PostgreSQL; organizer alert sources, outbox and OFF transport

**Status:** Accepted (developer, delegated by Dhia, 2026-10-30; Q-332, T-503 review 92 GO). Fills in what ADR-362 left open; the coordinator accepts it
after the review.
**Decision:** (1) **Rank push.** The top ten is read from PostgreSQL in the board's own order and rule (`enrollment_ranking_idx`
walked in order, `ranking_eligible` per row, stopped at ten), because a system seat has no reader for the Redis board read and
the Redis copy is rebuilt from this same rule; an event of 50,000 players costs one index range (about 260 ms with 600 leaders the
board keeps out). A tick every 10 s diffs each live event under a per-event try-lock; an event that is not live or whose ranking
switch (event or platform) is off loses its snapshot, so its return starts from a baseline. The 10-minute cooldown is read from the
`notice` table (no extra table); rehearsal accounts get no top-10 notice. (2) **Alert sources wired:** `activated` (draft to
scheduled), `size_limit` (each recorded 80% and 100% mark), `stock_low` and `codes_low` (a reward crossing into "at most
max(1, 10% of the total, rounded up) left"; only a crossing counts, so a change of the total alone never reopens an episode, and
only a live or ended event, because earlier only rehearsal accounts reserve), `support_access` (the `console.ticket_read` audit
row, once per admin, event and day), `new_flags` (a scan of the last 15 minutes, keyed by flag id, so the completion transaction is
untouched). `content_unpublished` has no source: owed to T-701/T-609. Quest-item pools are not covered (T-609). (3) **Outbox:** ids
only, one row per active member whose event limit and switch allow it at source time; the claim checks account, membership (a
membership started after the row is a new one), event limit and switch again and reads the address only for a row it leases. (4)
**Transport OFF:** the worker takes the existing `EmailSender` type; production gives none, so queued rows are skipped as
`transport_off` and no address is read. With a sender, a throw or an 8-second overrun is `uncertain` and never retried (the retry
allowlist is empty). Real cancellation of the token wait and the send, structured provider outcomes and the Saudi-transport or
counsel-approved transfer remain the gates before any real mail (ADR-360).
**Why:** the smallest build that meets ADR-362 without a lock, a trigger or a write in the quest-completion path, and without a
second email system.
**Trade-offs:** a rank change is seen one tick (10 s) late; the board read from PostgreSQL costs more with many leaders the board
keeps out (about 0.7 ms each); a flag raised while the API is down for 15 minutes sends no alert (no backfill, ADR-360).

## ADR-364 - Dashboard usability baseline before more features

**Status:** Accepted (Dhia's priority, 2026-10-30; approach by the developer, delegated by Dhia).
**Context:** Dhia found the staging dashboard unusable: small text, unorganized sections, overlapping controls. About 117
web components share one 373-line style file and no layout, form, table or type-scale primitives, so every page was
laid out ad hoc.
**Decision:** T-599/T-599b go ahead of every remaining feature task. A plain, clean admin look now: brand fonts (Rubik,
Baloo Bhaijaan 2) and brand colors as tokens only, no wood/parchment/3D yet (that is the later branded redesign, which
changes the tokens and primitives, not each page). No new dependency: CSS custom properties in one tokens file, CSS
modules and a small set of React primitives in `apps/web/src/ui/`, logical CSS properties for right-to-left. Body text
16px, nothing under 14px, a 4px spacing scale, a readable maximum content width, tables scroll inside their own box on
a phone. Styles the primitives replace are deleted, not kept beside them.
**Guard:** an automatic browser check walks every dashboard and console page at 1440 and 360 wide (FR-1746) in both languages
and fails on horizontal overflow, overlapping controls or text under 14px (CLAUDE.md rule 8: a repeated finding becomes a
check). New pages must use the primitives (`docs/rules.md`).

## ADR-365 - T-504 big screen: picked scenes, a PostgreSQL ranking read, polling and the photo wall split

**Status:** Accepted (developer, delegated by Dhia, 2026-10-30; Q-333, T-504 review 92 GO). A paired screen makes two requests every 3 s (device state and scene), about 40 a minute; revisit polling past about 100 live screens platform-wide. Fills in what the T-309 plan, ADR-221 and ADR-241 left to T-504.
**Decision:** (1) **Scenes.** One closed row per event (`big_screen.scenes`) holds the picked scenes in display order
(`ranking`, `community`, `poll`; none repeated; none allowed). No row means all three in that order. The ranking scene is not
offered, and a save naming it is refused, while the event's or the platform's ranking switch is off (FR-1612). Scenes live in the
`bigScreen` gated add-on (FR-1729): without it the screen says so and the Big screen page cannot save. (2) **Reads.** Each scene
has a door of its own that takes no argument (`screen_ranking`, `screen_community`, `screen_poll`) and reads only the calling
device's event; `device_view` carries the running list, so a change on the dashboard reaches a TV on its 3-second poll. The
ranking is the board's own rule and order read from PostgreSQL (`rank_top_ten_ids`, one index walk, as the rank push reads it),
so a score is on screen when its transaction commits and no Redis copy has to be rebuilt for a reader that is not a player. The
poll scene shows the newest sent poll that is open, else the one closed in the last 15 minutes, only in a public category (no
audience, not hidden, not held by a community goal), by the poll's results policy (`after_vote` live, `at_close` once closed,
`never` the number of voters only, FR-1613); the community scene shows the cached `community_goal.progress` and the milestones'
thresholds, never a reward. (3) **Polling, no stream.** The page re-reads the open scene every 3 seconds and rotates scenes every
15 seconds (fixed; skipped when empty). One answer per event and scene is shared for 2 seconds in the API process, so the database
sees one read per event, scene and 2 seconds however many screens poll. A server-sent stream (ADR-221) is not built: 3 seconds is
"within seconds" (FR-632), a stream would need its own revocation check and reconnect handling, and the cookie guard, rate limit
(40 a minute a device) and Revoke already hold on every poll. (4) **Photo wall split.** FR-635 to FR-637 move to **T-504b**: there
are no photos until T-301b, which waits for a second storage bucket only Dhia can open (Q-149). Nothing is built for them now.
**Why:** the smallest build that meets FR-630 to FR-634, FR-1612 and FR-1613 with the pairing, guard and rules already shipped.
**Trade-offs:** an unconfigured screen shows all three scenes; a screen's poll results can differ from a phone's by up to 5
seconds; the photo wall and its allow-on-screen choice (FR-636) wait.

## ADR-366 - T-599 dashboard navigation and page structure

**Status:** Accepted (developer, delegated by Dhia, 2026-10-30; Q-334, T-599 review). Fills in what ADR-364 left to the build.
Review changes: the one-link "This event" group is gone (its Event overview link sits under the organizer's name beside Events
and Team); the desktop rows are 32px so the whole list fits 1440 by 900; the dialog is a native modal `<dialog>`; the phone menu
makes the page inert and Escape closes it from anywhere; the layout check also reads the open phone menu and a dialog, at 360.
**Decision:** (1) **Navigation.** From 64rem wide a column on the start side lists the organizer (Events, Team, and inside an
event its Event overview) and, inside an event, the rest of that event's pages in three groups: Set up (quests, rewards, prizes
and results, community quests, double points, souvenirs, joining, invitations while Questify's switch is on), During the event
(players, operators, devices, big screen, announcements, help desk with its open count) and Review (submissions, flagged
activity, manual awards). The open page is marked. The top bar keeps the language switch, Home, My account and Sign out. (2) **Phone.**
Below 64rem a Menu button in the top bar opens the same list as a sheet, with Home, My account and Sign out at its end;
the top bar keeps only Menu, the product name and the language switch; while the sheet is open the page beneath it is inert
and Escape closes it from anywhere, returning focus to Menu. (3) **Event overview.** The page header (name,
status, join code) comes first, then activation and rehearsal, then the event form in parts (name and kind, place, time,
who finds it and how people join), then every on/off switch under one Features section as rows, then the streak, the
event words and a Delete or end section. (4) **Confirmations** are one modal `Dialog` (focus on its heading, Escape
cancels, the whole page behind it shut out of the keyboard and screen readers by the browser, focus returned to the opener). (5) **Look.** Plain admin styling from the theme's tokens: the wood top bar, parchment
surfaces, green primary buttons, gold for the open page; no wood or parchment textures (ADR-364).
**Why:** the old page piled 17 links in one paragraph above a form 8,000px tall; grouping by when the organizer needs a
page keeps the list short to scan, and a phone sheet keeps every page one tap away without squeezing the top bar.
**Trade-offs:** on a phone every page change is two taps; the event's name is not in the menu (it is in each page's
header).

## ADR-367 - T-599b page width, one box level and contrast

**Status:** Accepted (developer, delegated by Dhia, 2026-10-30; T-599b review 91 GO; Q-335).
**Context:** Dhia found pages that were not yet moved showing a narrow centred card with boxes inside boxes, a title squeezed into a
column, a link wrapping one word per line, and light text on a light fill when the pointer rests on "Home" in the dark header
(the navigation's item class gave the top-bar link the page's light background on hover).
**Decision:** (1) A dashboard page fills the content area from its start edge up to `--content-max`; only a single small form (sign-in,
a public landing page) is a narrow column. (2) A page shows one box level: a card, a form drawn as a card or a section inside
another is drawn plain (no border, fill or padding), and a list inside a box has lines between its rows. This is one CSS rule in
`ui/surface.module.css`, so a page cannot nest boxes by accident. (3) A button keeps its label on one line while its row has room
(`min-inline-size: min(100%, max-content)`); rows and section headers already wrap under their text before the text column
gets narrow. (4) The top-bar links take a dark veil on hover, never the page's light fill. (5) The layout check also fails on a box
inside a box, on text or a control crammed into a narrow column, and on any text under 4.5:1 (3:1 large) over what is behind it,
computed from the drawn colours, with each header, navigation and first page controls hovered and focused in turn (desktop). No
new dependency: the contrast reader is a small function in `apps/web/e2e/layout.ts` (`@axe-core/playwright` is not installed).
**Why:** the rules are checked on every page by one spec, not by review of each page.
**Trade-offs:** a section inside a section loses its own frame (its title still marks it); the contrast reader skips text over an
image (the dashboard has none) and disabled controls, as the guidelines do.

## ADR-368 - T-599c logo, icons, a shell that stays, and the browser-test budget

**Status:** Accepted (developer, delegated by Dhia, 2026-10-30; T-599c review 88, the MAJOR fixed in 82264dc; Q-336).
**Context:** Dhia asked for the photos to be fixed first, then the logo in the top bar, icons in the menu, language and Sign out as
icons, and navigation that does not feel like opening a new website. **Photos:** no `<img>` or background image on a dashboard, console
or public page fails to load: every picture the pages name (`/avatars`, `/currency`, `/souvenirs`) is in `apps/web/public`, tracked
by git, copied into the Docker image, and answers 200 on the staging address; the layout check, which now fails on an image with no
picture, passed on all 47 pages then listed, in both languages, before any change. What did fail on every page was `/favicon.ico` (404: the site had
no icon), and the event link's share image names an address that is not live yet (ADR-113's `questify.sa`). The dashboard shows almost
no pictures, so what Dhia saw is most likely the missing tab icon or a page that was not yet moved; he is asked to say if a picture is
still wrong (Q-336).
**Decision:** (1) **Logo.** The English wordmark of the brand deck (`docs/design/assets/logo/logo-wordmark-en.png`, which is not in git),
cropped to its edges and resized to 365 by 96, is `apps/web/public/brand/questify-wordmark.png` and replaces the name text in the top
bar, at 32px high. Beside it a signed-in dashboard page says "Dashboard" and a console page "Console" (hidden under 40rem); a player's
page says nothing. The brand's app icon, resized, is the tab icon (`favicon.ico`, `icon-192.png`, `apple-touch-icon.png`). No art was
made. The Arabic pages show the English wordmark until the deck has an Arabic one. (2) **Icons.** One line-drawn set of inline SVGs in
`ui/Icon.tsx` (no dependency), in the text colour; every navigation item has one, and the language switch (a globe, named "Switch to
{language}") and Sign out are `IconLink` and `IconButton` whose label is their accessible name and a CSS tooltip on hover and keyboard
focus; in the phone's menu sheet Sign out shows its word too. (3) **Navigation.** Every link to a page of the app is `AppLink` (Next's
`Link`, with no prefetch: every page reads the session and the API on the server, and a prefetched language link would change the saved
language). The shell moved out of each page into layouts so it stays while the page changes: `console/layout.tsx`, `organizers/{id}/
(workspace)/layout.tsx` (events, new event, team) and `events/{eventId}/layout.tsx` (which already read the event's words), each with a
`loading.tsx` that draws a page-shaped skeleton in the shell's content area. The navigation reads the open page from the address
(`usePathname`), the language switch follows the address, and a page change closes the phone's menu sheet. `currentStaff` is cached per
request, so a layout and its page share one `/me`. A segment's not-found reads its language from an `x-language` request header the
proxy sets. (4) **Public pages** say "Questify" and no area name (`area="public"`); `/q`, `/s`, `/t`, the event rules page and the event
not-found are in the layout check. (5) **The layout check** also fails on a picture that does not load, on text over an image or a
gradient and on text in a colour it cannot read, and reads a hovered or focused state at once with motion turned off, and the page's
requests with a 150ms quiet window, instead of fixed waits: a pass over a page now takes about 40% of the time (the check had grown to 4
minutes a project, which with a 2-core runner cost the whole 12-minute browser step of run 40993429874).
**Why:** a plain anchor reloads the document, the fonts and the shell, which is what made moving around feel like a new website; a
layout keeps the shell on screen while only the content changes; the icon set needs no package for 26 shapes.
**Trade-offs:** moving from the events list to an event swaps one shell for another (the same look); a link is not prefetched, so the
skeleton shows after one round trip; the Arabic pages carry an English wordmark; a page must still check the session itself, since a layout
does not run again when only the page changes.

## ADR-369 - T-307b the live finale: a closed row, a scene that takes the screen, the reveal stays the owner's

**Status:** Accepted (developer, delegated by Dhia, 2026-10-30; T-307b review 93 GO; Q-337). Fills in the T-307 plan's last section and ADR-230. Tier B: it only
reads `event_result` and `result_place`; points, the ledger, `confirm_results`, `reveal_results` and prize handover are untouched.
**Decision:** (1) **The finale** is one closed row per event (`finale`: `starts_at`, an optional `goal_id` of one of the event's community
goals). The owner alone sets it (`set_finale`) and clears it (`clear_finale`), audited with ids and the time. The time must be in the
future, inside the event's start and 24 hours after its end (the screen's own life); the goal must be this event's, not final, and
open past the finale's start. Once the time has come only Clear remains. (2) **It is not a pickable scene.** The three pickable scenes and
their CHECK are unchanged. A set finale joins the running list as its last scene; from its time on, and for good once the event has
ended, it is the only scene (`big_screen_running`). A screen of an ended event stays open while a finale is set (`screen_view_shut`);
the other three doors stay shut (`event_ended`). (3) **`screen_finale()`** (no argument, the calling device's event) answers a phase:
`countdown` (the time only, nothing of the goal), `push` (from the time on, while a goal is attached and the event's community switch
is on: its cached progress and milestones, never a reward; a missed goal reads "not reached"), `waiting` (no goal), `reveal` (only once
the owner's reveal ran: the top ten frozen places as place, username and avatar, never a score, FR-255). No place is read before the
reveal. The route adds `serverNow`, so the countdown follows the server's clock and not the TV's. (4) **Winners are revealed on the
Results page, not here.** The Finale section on the Big screen page sets the time and the goal and says where the results stand
(`results_state`) with a link to Prizes and results, where the owner confirms (after the event ends, ADR-163) and reveals; it never
duplicates that flow. Q-127 (confirming while live) is left as it is: a finale before the end needs the end time moved to it, and the
section says so. (5) **The app's celebration** (FR-407): Home carries `finale: {place} | null`, set once the winners are revealed; the
app plays one full-screen "The winners are in" per event on the phone (a key in its store), naming only the player's own place. It
shows when Home is next read; the reveal's push is T-501's.
**Why:** a finale page of its own would duplicate T-504's scene player, and a confirm/reveal of its own would duplicate T-214's guarded flow.
**Trade-offs:** a freshly set finale reaches a screen within about 5 seconds (the 2-second shared answer and the 3-second poll); a phone
learns of the reveal on its next Home read, not live; a goal deleted after being attached leaves the finale without its push.

## ADR-370 - Clear titles and icons, not explanatory text

**Status:** Accepted (Dhia, 2026-10-30).
**Context:** Dhia, on the staging dashboard: field after field carries an obvious sentence under it (for example "At least 12
characters. A phrase you can remember works well; leave out Questify and your email."), which "doesn't look professional at all".
He asked for this to be a strict rule for every page, now and later: the player app, the organizer dashboard and the Questify console.
**Decision:** (1) A page explains itself through its titles, labels and icons. No help line under a field, switch or button when the label
already says it. (2) A rule the user must meet to succeed (a password's length, a file's size, a code's format) is said once, briefly: as the
field's placeholder or a short hint, or in the error when it is broken. (3) A feature or field that genuinely needs explaining gets an info
button (an "i" or "?" icon beside the label) that shows the explanation on hover, focus or tap; it is the exception, not the default. (4) A short
line under a field stays only where it changes what the user does and the label cannot carry it (a warning that an action cannot be undone,
a price). (5) Controls that are universally understood by icon are icons with an accessible name and tooltip: show/hide password (eye),
sign out, language, close, edit, delete, copy, search. (6) Page intros under a title are cut to nothing, or one short line when the page
would otherwise be unclear.
**Why:** professional products read clean; text that repeats the label is noise and pushes the real controls down the page.
**Trade-offs:** some guidance moves behind an info button and is seen only by those who look for it; errors carry the rest.

## ADR-371 - T-599d how ADR-370 is built: info buttons, disabled switches, icon sign out, a guard test

**Status:** Accepted (developer, delegated by Dhia, 2026-10-30; T-599d review 91 GO; Q-338). Builds ADR-370; changes no data.
**Decision:** (1) **Info button.** The dashboard's `InfoTip` (`apps/web/src/ui/InfoTip.tsx`) is an icon button beside a label; the text opens on
hover, keyboard focus and a tap or click, and Escape, a tap elsewhere or scrolling closes it. `Field`, `FieldGroup`, `Switch`, `Checkbox`,
`NumberField`, `Section` and `PageHeader` take an `info` slot, and `infoTip(t, "key")` (`ui/info.tsx`) builds the button in the page's language.
The app's twin (`components/InfoTip.tsx`) opens the text under the label on a tap and closes it on a second tap; it sits on `SwitchRow` and `Field`.
(2) **Switches an editor cannot change** are drawn disabled, showing their state, instead of being hidden behind an "Only the owner can change
this." line per switch (the owner-only line stays where a whole part has no controls). (3) **Sign out** is an icon in the top bar, the phone menu
and the app's Profile and re-accept screens (the app keeps its confirmation); the password's show/hide is an eye icon. The app has no password field.
(4) **One new shared word:** `common.info` ("More information") names every info button. (5) **A guard test**
(`apps/web/src/lib/help-copy.test.ts`) lists every key named `...Hint`, `...Help`, `...Intro`, `...Note`, `...About`, `...Lead` as a kept help line or
an info text, and lists the keys passed as `help` or `description` to a field, section or page header: a new one fails until it is added to a list in
the same diff. (6) **What was cut or moved**, by rule: a line repeating its label, an intro under a title, an on/off status beside a switch, a
reassurance beside a button, and a per-type note under the quest type all went; real explanations moved to info buttons (64); rules to meet were
shortened and stay (password length, import format, number ranges); warnings about what cannot be undone, prices, locked or empty states stayed.
**Why:** one primitive on every page keeps the rule cheap to follow and visible in review. **Trade-offs:** an explanation behind an info button is seen
only by those who look for it; an editor sees a greyed switch without a spoken reason; the guard test is a naming convention, so a help line under an
unusual key name is caught only when passed as `help` or `description`, otherwise by a reviewer.

## ADR-372 - The push gate runs the browser specs of the changed area; the whole suite runs daily and by hand

**Status:** Accepted (developer, delegated by Dhia, 2026-10-30; tier C config, the repo is public so the daily run is free; Q-339). Builds ADR-368's browser-test budget; changes no data.
**Decision:** (1) The browser step of `ci.yml` (a push to `main`, a ready pull request) runs the layout check
(`layout.spec.ts`, `layout-check.spec.ts`) plus the specs of the areas the change touches. `scripts/ci-scope.mjs` picks them
from the changed files with the `AREAS` table (a pattern on a path or a message key, and the specs that cover it) and prints
`specs=` for Playwright; the reason goes to the step log. (2) The whole suite runs when shared code changed: the interface kit
(`apps/web/src/ui`), layouts, the global stylesheet, Next, Playwright and package files, the lockfile, workflows, this script;
e2e helpers that more than 20 specs import (found by reading the imports, through other helpers too); the API's root files and
its auth, db, audit, settings, completions and translations code; the e2e server and its direct helpers; an edited or removed
line in `app.ts`, `http-errors.ts` or the shared `index.ts` (added lines ride along: they list what other changed files use);
a web, API or shared file no area names; a text in `messages.ts` that changed or was removed and no area names (a new key
cannot change a page that does not use it); more than 20 specs' worth of areas (20 specs plus the layout check take about 9
minutes, the whole suite 16); or an unknown base (first push, force push). (3) A unit-test file starts no build or browser run.
Migrations, public images and `apps/api/src/home` run the layout check only, which boots the server and reads every page.
(4) `full.yml` runs everything, every browser spec included, every day at 01:17 UTC on `main` (about 900 minutes a month, free
while the repository is public) and by hand. (5) `scripts/ci-scope.test.ts` fails when a browser spec is named by no area, so a
new spec cannot be left out of a scoped run, and it covers each rule above. (6) The security floor is unchanged on every push:
secret scan, lint, limits ratchet, format, types, all unit, database, access and outsider tests (`ci:changed`), the API build,
the dependency audit; only the browser step is scoped.
**Why:** the whole suite is 16 of the job's 30 minutes and grows by about a minute with each feature; a change to one panel
cannot reach most specs, and the daily run still sees every spec on the same code.
**Trade-offs:** a break outside the chosen areas shows on the next daily run (up to a day later) instead of the push, so the
daily failure names a window of commits; a migration or an added line in a wiring file is trusted to the unit and database suites;
the table can lag the code (a file nobody mapped costs minutes, never coverage, because unmapped means everything runs). Measured on
the last 60 commits of `main` one by one: 33 needed no browser run, 20 the whole suite (CI and interface-kit work), 7 a scoped run of
8.7 specs on average, about 6 minutes.

## ADR-373 - T-505 agenda and sessions: free registration with seats, a warning on overlap, the door records attendance

**Status:** Accepted (developer, delegated by Dhia, 2026-10-30; T-505 review 93 GO; Q-340). Builds FR-808 to FR-810 and FR-1787 to FR-1797 except the session's points. Plan: `docs/plans/2026-10-30-t-505-agenda-sessions.md`.
**Decision:** (1) **Split.** T-505 ships sessions, registration with seats, My sessions, the overlap warning, close and reopen, the CSV import, the report and its export, reminders, messages to registrants, the linked quest, and the door check-in that records attendance. **T-505b (tier A, owed)** adds the session's points on check-in, once per player, and "everyone checked in to session X" as a bulk-award target (FR-1712); both write the points ledger, so they get a plan and a plan review first. (2) **Data (migration 0086).** `event_session` (a title in one language is enough, like a quest's; no price column), `session_registration` and `session_attendance` (both cascade from the enrollment, so the rehearsal wipe and a player leaving remove them; one row per player and session), `session_message` (the frozen text, the Idempotency-Key hash, the recipient count). (3) **Team doors** run inside `award_event_of` (owner or editor within the event limit): save, delete, list with the report numbers, close/reopen and seats, import (all rows or none, at most 500), message. Seats can never go below the registered number; a session with check-ins cannot be deleted. (4) **Player doors** need an active enrollment: the agenda with the player's own state, register, cancel. The session row is locked `FOR UPDATE` before the seat count, so the last seat goes to one of two players who press at once. A session that overlaps one the player holds returns `overlap` with the titles and writes nothing; the app asks and calls again with `confirmOverlap`. Registering twice is a retry, never a second seat. Cancelling deletes the row and frees the seat at once, until the start. (5) **Pushes** reuse T-501: `session_reminder` (one per registrant at the start minus the session's minutes, 1 to 1440, default 15, only while registered) and `session_message` (the announcement's text pipeline and its 140-character push body, 3 an hour and 10 a day per event). (6) **The door** is an operator with the `scan_quests` ability and no quest limit: `operator_sessions` lists the sessions from an hour before the start to the end, `session_check_in` takes a player's My QR (the version is checked like the station scan), records the attendance once and answers checked in, already, not registered, too early or ended; a player who did not register is a walk-in only when the organizer allowed walk-ins for that session. (7) **Screens.** Dashboard: an Agenda page under Setup (list, form, import, report export, message). App: the Agenda screen (All sessions and My sessions) linked from Event Home, and the door under Tools for operators with the scan ability. The agenda link on Home is always shown (no extra request).
**Why:** the registration needs a seat count that cannot be beaten by two phones, and nothing here moves points, sign-in or tenant isolation, so a mid-tier build with the full suite as the gate is enough; the points are the only ledger part and are kept for T-505b.
**Not built:** payment (registration is free, FR-1789), waitlists, recurring sessions, a session's own page on the web.
