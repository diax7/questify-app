# Inbox — Questify

Raw ideas, dated, close to the user's words. Each entry is sorted into the right doc, then marked
`→ processed`.

---

## 2026-10-30 — Less explanatory text, more icons (strict rule) → processed

- Dhia, quoting the password help line ("At least 12 characters. A phrase you can remember works well; leave out Questify and your
  email."): "I don't like having a lot of explanatory text. It's very obvious ... across the whole system, both now and in the future
  ... for players, for organizers, and for our team." Things that genuinely need it get "a question mark or an info tooltip"; a short
  line below is fine only "if it's truly needed". "Make things clear through clear titles and icons ... like professional websites do."
  Icons: an eye icon instead of the "Show password" button; sign out as an icon. "Apply this across all current and future pages as a
  strict rule, starting right now."
- Processed: ADR-370 (Accepted by Dhia), a `docs/rules.md` line, task T-599d (trim every page, `InfoTip`, password eye, sign-out icons).

## 2026-10-30 — Wireframe review of the new dashboard → processed

- Dhia, on the T-599 dashboard (Flagged activity screenshot): "now it is a little bit better ... this is not the final,
  it's just like wireframe, but it is good wireframe". Problems: the page content is "boxed" and cramped; the side menu
  needs icons; "changing the language should be an icon, sign out should be an icon"; navigating "doesn't feel smooth
  ... like it is opening a new website"; photos are broken on some pages: "fix the photos first. If you fix the photos,
  then yes, add the logo instead of Questify on the header"; contrast: the header "Home" hover hides the word, and
  light-on-light colours elsewhere.
- Processed: boxing and contrast went into T-599b (ADR-367, a contrast check in the layout check); photos, logo, icons
  and smooth navigation are task T-599c.

## 2026-10-30 — The dashboard is unusable; fix it first → processed

- Dhia, after using the staging dashboard (old build, 0056): "the UI is very disaster, it is unusable ... small text, not
  organized sections, overlapping things ... a lot of basic stupid mistakes". "For now I want something minimal, usable,
  nice to use and easy to be edited later"; the real branded design (3D elements) comes later. "If the new dashboard has
  the same problems, then this is high priority to fix ... not just fix it for now".
- Processed: task T-599 (dashboard usability baseline) goes ahead of every remaining feature task; ADR-364. The cause is
  structural: about 117 components share one 373-line style file and no layout, form, table or type-scale primitives.

## 2026-10-29 — Recovery and continued coordination → processed

- Dhia: "check where did he end, and keep working, follow all the docs and take the lead"; then "Keep going"
  and "why arent you doing anything?" after the coordinator stopped at the T-502 checkpoint.
- Processed into STATE and COORDINATOR_HANDOFF: the current instruction resumes the task queue after green T-502 CI;
  the previous session's break request is historical, not a reason to stay idle. Next is T-503, following the tier
  and independent-review gates. No deployment, EAS build or external credential action is implied.

## 2026-10-16 — Session 1: the founding idea → processed

Into `PROJECT_BRIEF.md`, `FEATURES.md`, `DECISIONS.md` (ADR-001–005), `OPEN_QUESTIONS.md`.

- First app to launch on the App Store and Google Play. Wants to pass review on the first upload:
  privacy policy, terms and anything else stores require.
- One codebase, near-native feel. Develops on Windows with Claude Code; can borrow a Mac for
  testing and deployment.
- Saudi Arabia first, usable anywhere.
- **Flexibility is the top architectural concern:** white-label design, adding new ways to
  interact, enabling or disabling features from the admin dashboard while live, without code
  edits or new store submissions.
- Core idea: gamify events with quests. Quest types: scan a QR code, complete a challenge, submit
  something, vote, answer a question. Each quest shows the points it gives.
- Points or XP collected per event; the admin chooses the currency type and name.
- Leaderboard of who collected the most in the event.
- Store: redeem points for real prizes set by the admin (t-shirt, subscription, gift card).
- Admin dashboard handles all event features: quests, prizes, leaderboard, feature toggles.
- One app for any event planner worldwide, also for workplaces (company activities). Works for
  physical events as an add-on and for fully virtual events.
- No payments for now. SMS messaging and email are in.
- Considering Supabase for auth and database; not decided.
- Design: authentic, lots of animation, visible progress, 3D icons and elements. No "AI slop"
  gradients or basic designs. The user will send UI/UX reference images.
- Wants worldwide research on event apps and gamification to do better than them.

---

## 2026-10-16 — Session 2: compliance answers + brand deck → processed

Into `DECISIONS.md` (ADR-006 to ADR-013), `OPEN_QUESTIONS.md`, `FEATURES.md` (F-50 to F-68),
`design/REFERENCES.md`, `PROJECT_BRIEF.md`.

- White-label = one app with everyone's events inside it. Agreed.
- Remote config limits understood. The demo event has everything on, but things can be closed
  later.
- No raffles.
- No reward for turning on notifications or location. **But** some quests or events may be
  restricted by location, and a player without location can't enter them. Nobody is forced.
  → Q-019
- Moderation: "we will do everything in v1". The user wants the first version to be complete with
  every feature. Filter, report and block will exist in some form. → Q-007
- Reviewer demo: a demo event covering every quest type, and a demo-only option to pick a
  quest's QR from a list instead of scanning it, plus a reviewer phone number and QR codes.
  → ADR-009
- Developer accounts: personal Apple and Google accounts; fine with the name showing. → ADR-010
- PDPL: will try to comply as far as practical; not a blocker. → ADR-012
- Framework: something Flutter-like that runs on both near-natively, or Flutter itself. Decide
  later, once features are complete. → Q-030
- Prizes come from the organizer. Questify is like a partner of the event, making it alive with
  the digital experience. → ADR-011
- Saudi lawyer: collect all legal questions, review once at the end.
- **Brand deck (Questify.pdf) is "the most important thing ever"**: logo, colors and the
  adventure-game design system apply to the whole app, including animations and transitions. The
  business, scope and client pages are inspiration and can be changed. → ADR-013, R-01
- Found in Downloads: `Questify_BRD_v2.docx` (April 2026), an earlier single-event version with a
  cyberpunk theme. Copied to `inputs/`. Its non-conflicting details were imported (F-53, F-55,
  F-56, F-60, F-61, F-66–F-68).

---

## 2026-10-16 — Session 10: feature brainstorm, Area 1 (joining and onboarding) → processed

Into `FEATURES.md` (Area 1), `DECISIONS.md` (ADR-030 to ADR-032), `OPEN_QUESTIONS.md` (Q-070).

- Brainstorm area by area, in journey order (14 areas); ground each in the research.
- Sign-in: phone only at first, then email added so company-domain locks work. Saudi +966
  numbers only.
- Browse first, sign in to earn.
- Wants: one-scan join with a deferred deep link and an event web page, guest lists with a
  company-email lock, a welcome reward. Not WhatsApp login codes.
- Nickname and avatar in public; the real name only if the event asks for it.
- Organizers can add a few join fields.

## 2026-10-16 — Session 10: Area 2 (quests), first half → processed

Into `FEATURES.md` (Area 2), `DECISIONS.md` (ADR-033 to ADR-036).

- "Yes start, no need to ask me": go from area to area without asking.
- All four new quest types: enter a code, meet someone, survey, location check-in.
- Submissions: photo, text and short video.
- Mini-games built into the app, 3 to 5 of them.
- Reward social shares on the honor system (after Claude's pushback).
- Quiz: one try per question.
- Quest structures (chains, daily and weekly, boosts, hidden): "will tell you more".

## 2026-10-16 — Session 10: Area 2 (quests), second half → processed

Into `FEATURES.md` (Area 2), `DECISIONS.md` (ADR-037 to ADR-039), `PROJECT_BRIEF.md` (operators).

- **Categories:**
  - every quest is inside a category;
  - an optional bonus for finishing the whole category, on top of the quests' points;
  - categories expand and collapse; collapsed shows "2,000 of 10,000, 3 of 10 done";
  - the admin sets the quest order and whether it must be done in order;
  - "the UI should be very nice, giving all the needed information". Design comes later; we are
    writing requirements now.
- **Polls:** the organizer asks all participants to pick one or several options, with or
  without points.
- **Four user types:**
  - the platform admin (the Questify team);
  - the owner of the activity (all settings, challenges and brand);
  - operators (scan QR codes, add points, redeem prizes; can't change settings, names or quests);
  - players.

  More detail later.
- **Community quest (optional):** all players work together, e.g. raise one million points
  together; if they reach it, there is a prize for everyone, or something happens. Everything
  is flexible for the admin: what the quest is, how it is achieved, and the prize, if any.
- **Asked for:** new ideas to gamify the event experience itself, not only quests. Picked: flash
  quests and boosts, live finale, every category option, and "organizer picks" for how players
  contribute to a community quest.

## 2026-10-16 — Session 10: Area 3 (verification and fair play) → processed

Into `FEATURES.md` (Area 3), `DECISIONS.md` (ADR-040 to ADR-042), `OPEN_QUESTIONS.md` (Q-071),
`STORE_COMPLIANCE.md` (PD-12).

- **Three redemption methods:**
  1. the user scans the QR code (printed from the admin panel);
  2. the operator scans the user's QR code;
  3. NFC.
- **NFC:**
  - the app helps program the NFC tags (go to the quest, "write to NFC", hold the tag to the
    phone);
  - NFC and QR can both be active, with the QR as backup;
  - "What else could we have? Any new options for flexibility?" Picked: rotating QR on a screen,
    unattended kiosk, operator manual award.
- **A very small ticketing system:** "raise a ticket" or "ask a question" for broken QR codes and
  questions; the operator reviews, replies and fixes.
- **Unusual patterns:** don't hold points, just flag them. A dashboard page for flagged
  suspicious activity: several accounts on one phone, GPS far from the event. No automated
  actions; the admin reviews and handles each case.
- Owner sets caps on manual points. Meet-someone: one scan, both earn. Submissions: allow
  auto-approve.

## 2026-10-16 — Session 10: Area 4 (points, levels, streaks) → processed

Into `FEATURES.md` (Area 4), `DECISIONS.md` (ADR-043 to ADR-045), `OPEN_QUESTIONS.md` (Q-072,
Q-073); Area 7 renamed and moved up.

- Leaderboard ranks points earned. Currency: a name plus an icon from our set.
- **Levels: "very important and will open a big door."**
  - **Across all events:** a personal profile related to Questify itself, with levels, special
    items, achievements, characters, a frame for your character, a special avatar, and name
    features like a name color.
  - **Quests for Questify itself:** attend three events, follow us.
  - **Why:** it enhances the experience and encourages users to join more activities. It
    encourages events to adopt Questify, because it will already have a large base of players.
  - **Invitations:** to quests based on players' categories, preferences and previous events.
  - **A single database of all users:** the events they attended, how active they are, and a
    complete profile. Useful for marketing, commercial and app purposes. "A very big piece… we
    need to discuss it further."
- **Streaks:**
  - both kinds;
  - an event streak if the organizer wants it, with or without points;
  - a Questify streak to encourage opening the app daily;
  - both can be switched off.

## 2026-10-16 — Session 10: Area 7 (the Questify layer) → processed

Into `FEATURES.md` (Area 7), `DECISIONS.md` (ADR-046 to ADR-048), `OPEN_QUESTIONS.md` (Q-016,
Q-072, Q-073 closed).

- Items: avatar frames, titles, extra characters.
- Earned through level-ups, achievements and Questify quests, event souvenirs, and a Questify
  shop.
- Player data: "all".
- Organizers reach other players only through Questify invitations.
- Gems from Questify quests, achievements and level-ups.
- After the event: a shop window, then the balance closes.
- Daily: "daily challenge or any Questify activity".
- Recaps: event recap only.

## 2026-10-16 — Session 10: Area 5 (rewards shop) → processed

Into `FEATURES.md` (Area 5), `DECISIONS.md` (ADR-049 to ADR-051), `OPEN_QUESTIONS.md` (Q-010,
Q-018 closed).

- Prize handover: reserve, then pick up.
- Digital rewards: the organizer uploads codes.
- Rank prizes: yes, with a legal flag.
- Shop ideas: prizes as quest rewards, pin a goal.

## 2026-10-16 — Session 10: Area 6 (leaderboard, big screen, navigation) → processed

Into `FEATURES.md` (Area 6), `DECISIONS.md` (ADR-052 to ADR-054; ADR-044 confirmed).

- Fixed XP per quest.
- **Ranking:**
  - show the top 10 and your place;
  - in the top 10 you're highlighted;
  - at 11 or below you're at the end, highlighted;
  - at least 11 players without scrolling: "I don't want scrolling."
- **Mobile bar:**
  - five items, two on the left and two on the right;
  - in the center, scan or redeem as a big round button that's "not very regular";
  - the four items weren't decided, then were chosen: Home, Quests | ● | Rewards, Profile.
- **Questify homepage:** reachable "in an easy and very clear way", but not from the mobile bar,
  so a player doesn't leave the event by mistake.
- Rankings: today's and Questify-wide. Everyone visible. Big screen: every scene. Ties: first to
  reach. No freeze. Rank alerts for top-10 moments only.

## 2026-10-16 — Session 10: Area 8 (event home, maps) → processed

Into `FEATURES.md` (Area 8), `DECISIONS.md` (ADR-055, ADR-056, ADR-053 extended).

- Event Home: Up next, Happening now, announcements, event info page. Light agenda.
- **Maps "should have flexibility":**
  - some events just upload a photo;
  - others have a plan per floor with quests and sections placed, easy from the admin panel;
  - it's "not a navigation app, just a reference for where to go";
  - multiple floors or maps (floor 1, outdoor) that players switch between;
  - a map may be just a photo, or a photo with information.
- Questify home bar: Home, Explore | ● | Shop, Profile.

## 2026-10-16 — Session 10: Area 9 (staff mode) → processed

Into `FEATURES.md` (Area 9), `DECISIONS.md` (ADR-057, ADR-058).

- **Joining as an operator:**
  - "a special way to log in";
  - a complex QR code generated one per person; scanning it makes them an operator for that
    event, after a confirmation;
  - "let's make it both": the admin can also add an operator by phone number or email.
- **Playing:**
  - an operator can't take part in the event by default; the organizer can allow it;
  - then the operator has two options, operator mode and visitor mode, and switches easily;
  - operator mode has different options, icons and home bar.
- **Names are variables:**
  - player, user or guest; operator or something else;
  - configured once by the organizer and applied everywhere;
  - "the system should have variables… based on each event those words could be changed in
    one place."
- Abilities are toggled per operator, all on by default. The same for booth limits: everything
  by default.
- Asked for each staff-mode idea to be explained one by one. After the explanation, picked all of
  them, practice mode, and the proposed operator bar.

## 2026-10-16 — Session 10: Area 10 (organizer dashboard) → processed

Into `FEATURES.md` (Area 10), `DECISIONS.md` (ADR-059 to ADR-064), `OPEN_QUESTIONS.md` (Q-059
closed, Q-064 narrowed).

- Team: owner + editors. Setup: templates and duplicate.
- **AI wizard, in the user's words (summarized closely):**
  - it "should be very amazing… an interactive session";
  - the AI asks the organizer to describe the event, then asks again based on the answers (how
    many quests? QR code or NFC?), often as buttons;
  - it knows which information it needs, asks about what it doesn't know, repeats or explains
    when needed, and moves to the next area;
  - it works on existing events too: edit quests, add or fix translations;
  - at the end, "apply all the changes", with the AI saying one by one what it will change,
    add or delete; the organizer approves everything or selects a few, or goes back to the
    wizard and explains again;
  - "Let's make it a future version… make the system infrastructure ready now so the AI can
    edit and add those things."
  - Provider undecided: OpenAI, Google or Claude.
- **Branding:** for the adventure theme, not even an accent color; just logo, banner, words and
  currency, "but maybe we will not do that brand yet". More customization only with another
  theme, a later decision.
- Scale: up to 50,000+.
- Control room: everything. Preview: in the dashboard only. Billing: invoice, then Questify
  activates.
- **Live edits:**
  - edits ask "only future completions, or also previous ones";
  - deleting asks whether to remove the points from people who completed it; "dangerous", so
    it needs a confirmation and an explanation;
  - "anything that requires a confirmation, like logout, deleting, editing: a pop-up or screen
    explaining what exactly will happen, and he must confirm after he reads."

## 2026-10-16 — Session 10: Area 11 (notifications) → processed

Into `FEATURES.md` (Area 11), `DECISIONS.md` (ADR-065), `STORE_COMPLIANCE.md` (PD-24).

- Push cap: none. Prayer and quiet times: none.
- Organizer announcements: push and in-app.
- Questify promotional messages to opted-in players: push, email and SMS.

## 2026-10-16 — Session 10: Area 12 (analytics) → processed

Into `FEATURES.md` (Area 12), `DECISIONS.md` (ADR-066; ADR-039 and ADR-043 corrected).

- Analytics: participation, quests and categories, rewards and economy. Time and heatmap
  dropped.
- Exports plus a one-page report. Extras: survey results, quest ratings.
- **"What is donated? We don't have this."** After the explanation: "this is not donating points.
  It is like participating points, because the points are not deducted from their balance; this
  is just a general balance for everyone."

## 2026-10-16 — Session 10: Area 13 (sponsors) → processed

Into `FEATURES.md` (Area 13), `DECISIONS.md` (ADR-067), `PROJECT_BRIEF.md`.

- Sponsor profiles: yes. Report link: no. Leads: none in v1.
- Placements: a presented-by category and a sponsor strip on Home.

## 2026-10-16 — Session 10: Area 14 (platform admin, trust and safety) → processed

Into `FEATURES.md` (Area 14 + platform foundations), `DECISIONS.md` (ADR-068),
`STORE_COMPLIANCE.md` (PD-11).

- Organizers sign up freely; activation is the approval.
- Safety: report, nickname filter, block, platform-wide ban.
- Support: full edit, logged.
- One admin role, logged.

## 2026-10-16 — Session 11: scope → processed

Into `SCOPE.md`, `DECISIONS.md` (ADR-069), `FEATURES.md` (F-89 deferred).

- "My device just restarted with the blue screen, please keep going. Use the ask user question
  tool."
- Release: everything in v1. Pilot: not yet. Deferred: video submissions only.

## 2026-10-17 — Session 11: compliance review → processed

Into `DECISIONS.md` (ADR-070 to ADR-073), `STORE_COMPLIANCE.md` §6, `FEATURES.md` (F-225, F-226).

- "Let's discuss them one by one, because I don't understand what you want from me."
- Data in Saudi Arabia. No AI moderation in v1.
- Location: "all the time while the app is open".
- Photos: first "the same as all apps (some or all photos)"; after the picker was explained, the
  system picker.
- PD-29: first "no checks"; after the pushback, report + unpublish.
- PD-28: "By default we enable everything… if we want to disable something, we don't have to
  worry about it."
- PD-03/04: "From our current features we can disable and enable. When disabled, it is hidden,
  like it's not there. But not actually adding new things."

## 2026-10-17 — Session 11: SRS quality targets and gaps → processed

Into `SRS.md`, `DECISIONS.md` (ADR-074, ADR-075), `FEATURES.md` (notes), `OPEN_QUESTIONS.md`
(Q-074).

- Targets: 99.9% availability, iOS 16+ and Android 9+, 20,000 scans a minute, ranking within 5 s.
- Votes: options written by the organizer only.
- Phone accounts can add a verified email.
- Age: year-based.
- Removing points after spending stops the balance at zero.

## 2026-10-17 — Session 11: Stage 1 gate → in progress

- "So far I think it's good. But I would prefer more details and discussion… more ideas, just
  review what we have done so far. See what gaps come to your mind, compare it with the
  competitors… another review of Stage 1 to make sure it is all complete and there are no gaps,
  no assumptions. Then we go to the next stage."
- → Four independent review passes: the player journey; the organizer, operator and admin
  journeys; competitors and the Saudi market; consistency and assumptions. Findings go to the
  user in question batches.

## 2026-10-17 — Session 11: grilling the Questify-owner side → in progress

The user asked to use skills (superpowers, interview, grill) to look at gaps "for the owner side,
from our side". The grilling skill runs one question at a time. Answers are applied to the docs
once the user confirms a shared understanding. Stage 1 review findings: `_blueprint/STAGE1_REVIEW.md`.

1. **Legal entity:** an existing company of the user's.
2. **Invoicing:** "For now we will not do invoicing from the platform… the invoicing, the pricing,
   everything will be outside the platform. We will just accept it here." No company or VAT data
   in the platform.
3. **Paid size:** at activation, the admin chooses a hard limit, a soft limit, or no limit.
4. **Activation:** "all the options". The owner requests it in the dashboard; a Questify admin
   activates any event directly; Questify can create events for organizers.
5. **Managed events:** built in the client's own account, then handed over to the client as owner.
6. **Editors** run everything on event day (operators, caps, exclusions, award removal, bans,
   pausing redemption, control room). The owner keeps the account level: team, activation
   requests, ownership transfer, account deletion.
7. **The owner can optionally limit an editor to chosen events.**
8. **Dashboard sign-in:** email + one-time code (first answer).
9. **Platform admins:** "email + pass + otp. Apply the same thing for owners."
10. **The code comes by email.**
11. After Claude's pushback (an authenticator for platform admins only), the user chose "email
    code for everyone". The risk is recorded: one compromised admin mailbox exposes the whole
    platform.
12. **Editors sign in the same way as owners** (email + password + email code).
13. **Support:** "Only contact us through WhatsApp. This is the hotline and the help… and we have
    two options, through email or through phone number." Outside the platform; the dashboard
    shows the contact details.
14. **Email alerts to organizers,** on or off per type.
15. **The admin unlocks add-ons per event** at activation (packages sold outside the platform).
16. **Usage view in the console:** SMS, promotional messages and push sent, players and storage
    per event and organizer.
17. **Organizer terms:** click-through at sign-up, versioned (terms, DPA, content rules).
18. **Daily challenge questions:** the team writes them all by hand.
19. **Empty bank:** no challenge that day; the console warns 7 days ahead.
20. **Reports:** handled within 24 h, and within 1 h during live events.
21. **The Questify team at launch:** 3 or more people.
22. **Admin roles:** keep one role (Claude recommended super admin + team member).
23. **Rehearsal mode for the organizer's team** on Draft and Scheduled events: real phones, real
    QR codes and tags, the big screen; wiped at go-live; strangers can't join.
24. **Storefronts:** Saudi Arabia + GCC (Claude recommended every country except the EU).
25. **Peak:** up to 10 live events at once, about 100,000 players live in total.
26. **Backups:** lose at most 5 minutes; service back within 1 hour.
- **The owner-side summary was confirmed: "Right; keep grilling the other open items."**
27. **Weak signal:** online-only everywhere, including operator devices (Claude recommended a queue
    on staff devices only).
28. **Celebration:** an instant "Scanned! checking…" beat within 300 ms, then the full celebration
    when the server confirms.
29. **Rank winners:** the organizer confirms them (with open flags shown) before the reveal.
30. **Prize pickup:** one prize desk per event (location and hours).
31. **After the desk closes for good:** only digital codes can be redeemed; rank winners get a push
    with the claim deadline.
32. **Players aged 13–17:** "no difference".
33. After Claude's pushback (block only promotional messages to under-18s), the user kept "no
    difference at all". The PDPL consent risk goes to counsel (Q-042).
34. **Accessibility target:** "nothing". The reduce-motion rule stays as a performance fallback.
35. **Audience targeting:** yes; a category or reward can be limited by join field or guest-list
    tag (women / families / VIP / department).
36. **Teams-lite:** no; individuals only (ADR-025 stands).
37. **Lead sharing:** none in v1 (ADR-067 stands).
38. **Event day start:** set by the organizer; default 4:00 am in the event's time zone.
39. **Event streak:** consecutive event days; closed days don't break it.
40. **XP:** "For our side, we don't care about difficulty now. Each quest gives a hidden X amount,
    and that's it. Maybe later give points based on difficulty; I can turn this on as an admin
    in the platform. We as the Questify team also have the flexibility to change, edit, add."
41. **Repeats and refreshes:** XP only the first time; an admin setting can change it.
42. **One accent color per event** from a curated palette (ADR-061 widened).
43. **Two accounts on one device** (phone + email) are flagged for the organizer.
44. **Player safety:** leave an event, unique names. Not picked: sign-out of other devices,
    re-checking before redeeming.
45. **Usernames:** "strictly unique… like their gamer tag. This is the username, not just a
    nickname. Change it from nickname to username or an ID." Shown as @username on the profile.
    Whether changing is allowed is up to the Questify team (a platform setting). Even after a
    change, the previous usernames are known.
46. **Rejected submissions:** the organizer chooses per quest whether resubmitting is allowed.
    Late approvals: Claude's default (score and rank always; balance only during the shop window),
    to confirm.
47. **Re-sign-up:** bans and one-time rewards stick to a one-way fingerprint of the phone or
    email, even after deletion.
48. **The ten defaults Claude wrote into the SRS** (FR-1607, 1415, 1602, 213, 252, 1610, 1616,
    1618, 1625, 139): all kept.
49. **Operations pack:** bulk/compensation award, regenerate a QR, batch operator QRs with
    presets. Not picked: operator auto-expiry and the live operator list.
50. **Streak freeze, "most improved", live completion counts:** none.
51. **Ramadan and national-day templates, ticket-number check, Hijri dates, parallel-session
    rule:** none.
52. **Phone dashboard:** everything must work on a phone.
- **The second-branch summary was confirmed: "Yes, write it all."** → processed into ADR-076 to
  ADR-085, F-228 to F-265, SRS §1.17, `SCOPE.md`, `STORE_COMPLIANCE.md`, `OPEN_QUESTIONS.md`.

## 2026-10-17 — Session 11: Stage 1 approved → processed

- "Approve; Stage 2 reuse check."

## 2026-10-17 — Session 11: Stage 2 reuse check → processed

Into `DECISIONS.md` (ADR-086), `SCOPE.md`, `OPEN_QUESTIONS.md` (Q-031).

- Backend: managed PostgreSQL in a Saudi region, plus proven libraries.
- Game logic: built in-house.
- Notifications: a thin in-house layer.

## 2026-10-17 — Session 11: Stage 3 (business) → processed

Into `BUSINESS_MODEL.md`, `METRICS.md`, `PRICING.md`, `GO_TO_MARKET.md`, `DECISIONS.md` (ADR-087).

- "Codex now is running, you start next stage."
- First customer: organizers and agencies. North-star: activated players per event.
- Tiers: 300 / 1,000 / 5,000 / 20,000 / custom, plus add-ons.
- **On add-ons:** "We can provide them anything we want. We can also give organizers gifts, devices,
  screens. This is not related to the system; the system focuses on the system itself. What's
  outside, we deal with them separately and get paid separately. You don't need this."
- Riskiest assumption: players will install an app. Channels: direct outreach and agencies.

## 2026-10-17 — Session 11: Stage 4 (UX) → processed

Into `UX_FLOWS.md`, `ux/PLAYER.md`, `ux/OPERATOR_MODE.md`, `ux/DASHBOARD_AND_CONSOLE.md`.

- "Design is a very, very important aspect… the adventure theme looks okay, but we might change it
  completely. Don't rely on it. Focus on user experience and wireframes."
- Chosen from sketches: Home stack (Up next first), accordion Quests, bottom-sheet quest details,
  ranking card on Home, camera-first center button, balance-on-top grid for Rewards, identity-first
  Profile, join card first.

## 2026-10-17 — Session 11: UX review with the user → processed

Into `DECISIONS.md` (ADR-088), `ux/OPERATOR_MODE.md`, `ux/DASHBOARD_AND_CONSOLE.md`, `SRS.md`
(FR-1008, FR-1747), `FEATURES.md` (F-68).

- "Let's review them together… most of the things that you skipped without telling me. I'd like to
  know more about how you designed the dashboard, operator mode, the flow, everything. Maybe I
  will approve, maybe I will change."
- Operator mode: approved. Undo on Handed over; banned player's items held; results stay.
- Dashboard: one language required; activation any time; last save wins; sideways strip.

## 2026-10-17 — Session 11: player-app review notes → processed (partly)

Into `ux/ONBOARDING_WIZARD.md`, `research/WALLET_PASSES.md`, `FEATURES.md` (F-267 to F-271),
`SRS.md` (FR-1749 to FR-1757), `DECISIONS.md` (ADR-090).

- **Flexibility ("very important"):** as the Questify admin team, change the order of items,
  rearrange the items on the mobile bar, hide a page.
- **Onboarding wizard ("very important", especially for the event owner):**
  - when creating an event, a step-by-step guide that asks about all the options;
  - for each, shows an example or view so the owner can imagine using it; a hint such as "NFC
    requires physical devices, bought or given by the Questify team"; QR can be printed or shown
    on a screen or mobile;
  - any part can be skipped, or the whole wizard; the owner can change everything later;
  - the reason: without a guide the owner won't know the customization options exist;
  - sponsors: "Do you have any sponsors? We can show them here and here: Add sponsor or Skip."
- **Apple Wallet and Google Wallet (open):**
  - visitors keep their QR code and points as a wallet pass instead of using the app;
  - maybe branded by the event, or just Questify-branded and global;
  - "what can we do and how much can we change in the wallet after it's added, what are the
    options?"
- Answers after the research: **full wallet, no rotating ID, "I accept the risk"**; Questify frame
  with the event's logo and name; the Questify team sets default layouts and organizers pick from
  approved layouts; the player app is approved with these changes.
- On Q-076 and the lawyer question about wallet data abroad: "yes" to both (an expectation, not yet
  confirmed).
- **Admin flexibility ("I want the maximum flexibility possible. What can we change in the
  application itself?"):**
  - picked: edit any app text live as a **translation matrix** ("all the strings in Arabic and the
    equivalents in English, and at any time we can change any one of them or both"), off switch for
    any feature, tuning numbers, maintenance mode, a banner to all players, editing items,
    achievements and gem prices;
  - **countries:** "I want to enable all the countries but not the EU ones" (ADR-092);
  - safety tools (draft, rollback, last-working copy): "none of those, but I think we need more
    options as admins";
  - asked: "did Codex finish the mascots?" (3 of 10 so far).
- Safety tools: only the last-working copy on the phone. More admin tools picked: all four player
  tools, all four message and filter tools, and four operations tools (health dashboard, organizer
  account tools, admin accounts and sessions, ranking seasons).

## 2026-10-17 — Session 11: sessions and the player onboarding → processed (sessions)

- "What if there is a session, a speaker, a workshop or an activity? Some require registration and
  are limited, some are open. Later we may sell tickets, but let's pass that."
- Answers: registration "both, based on what the owner wants; the session could have speaker name
  and description"; no waitlist (just show Full); My sessions, reminder, overlap warning, door
  check-in; import, attendance report, open/close registration live, message registrants.
- **Player onboarding (new request):** "an onboarding for him, to explain the first time he
  downloads: about Questify and events… very visual and nice UI/UX."
- Mini-games: "we didn't discuss how they will be, when and where."
- Player onboarding answers: four story cards; from a join link the event and join come first, then
  the full intro with Skip; replay from Settings; content editable by admin.
- Mini-games answers: memory match, slide puzzle, catch, a daily word game ("you try to guess it"),
  tap rush, pattern repeat; attempts "default 1, but changeable"; reward for passing the target; then
  dropped one to stay at five; the daily word lives on Questify home only; six guesses.

## 2026-10-17 — Session 11: Stage 5 (pressure-test) → processed

Into `_blueprint/STAGE5_GRILL.md`, `DECISIONS.md` (ADR-098 to ADR-100), `FEATURES.md`, `SRS.md`.

- Codex: the image limit blocked generation; seven mascot images and one fennec correction remain;
  reset 18 October, 3:09 pm Riyadh.
- Confirmed: no account restore after deletion; email + password + code is "very safe"; Apple allows
  an event logo; the lawyer accepts pass data abroad.
- Stage 5 answers: no review point for the plan; "all of it" as the reason; store accounts stay
  personal; 3 minutes to the first coin, install included; weekly then daily content; Questify
  absorbs SMS cost; flags hold the prize handover.

## 2026-10-17 — Stage 6 (tech)

- "start Stage 6. Give me all the options and why each one I should pick, like the pros and cons. And
  why, what you recommend and why do you recommend that? And do your research before, like exactly about
  the technology. Consider that I don't have a MacBook, but I can provide a MacBook for a little bit of
  time, so I can publish the app if it's needed. I would prefer not two completely different applications
  for the two platforms, just one for both. And if you can, also support the web, completely all the
  functionalities; this is a plus, but not mandatory." → ADR-101, F-318, FR-1816. Processed.
- Framework answer: Expo (React Native) + TypeScript, Claude's recommendation. → ADR-101. Processed.
- Cloud answer: "I will see later." → Q-031 stays open. Processed.
- SMS answer (Arabic): "Msegat or Taqnyat" ("مسجات او تقنيات"). → ADR-103. Processed.

## 2026-10-18 — Wireframe review: more customization and options (not yet processed)

Raw, close to the user's words. Status: **brainstorming; nothing is decided or applied until the user says "all changes are approved".**

- Liked the current wireframe. It is missing the *many options / all the customization* the user expected.
- Wants: the event owner can hide things (e.g. "there is no prizes"), and see reports.
- **Tickets:** players can raise a ticket. A ticket can be a report of a player, a suggestion, or a bug in the app. Not in the wireframe. Should exist **for the event owner and for the Questify team** to handle.
- **Feature flags, platform level:** the Questify team can completely turn off a feature so no one gets it, "like this is not even developed". Wants this type of flag.
- **Feature flags, per event:** the same enable/disable per event.
- **Hard limit** on participants per event.
- **Three event types:** (1) **Public:** anyone can see it and anyone can join. (2) **Unlisted** (working name; "join with QR"): not listed, join with a QR/code/link. (3) **Private:** the code is not enough; players *request to join* and the owner *accepts* them, or the owner *invites* someone. Difference between 2 and 3: with 3 you need the code **and** acceptance. User: "I'm adding a new requirement, not sure."
- **Reservation of prizes:** the owner can enable or disable reservation ("maybe he doesn't want to"). An option.
- **Home page layout:** owner can reorder blocks ("I want this before this"), hide blocks; a default layout exists but can be changed.
- **Leaderboard layouts:** two designs, e.g. a plain list, or a **podium for the top three**; the owner picks one. Wants to know what other pages could have two layouts.
- **Banners:** more than one banner on the home page; a **slider/carousel** between images; can show one slide. Optionally a **countdown** with a date the owner sets. "I'm not sure what else on the home page, because the home page is very important to customize."
- Wants a brainstorming question round on customization and options for the Questify team and for the owner. After the user is satisfied they will say the changes are approved, and only then edit the wireframe.
- **Wireframe changes wanted later (when editing):** add the missing tabs; make **every step of the setup wizard** clickable so progress is visible; make skipped pages and tabs clickable with more detail instead of placeholders.
- Brainstorm rounds 1–6 answered the same day; the answers and the proposed rules are in `_blueprint/WIREFRAME_REVIEW.md`. Still **pending approval** (nothing applied to SRS, FEATURES, DECISIONS or the wireframe). Extra words from the user in round 6: "the player can review the reports and the replies from his profile page, and from his profile he can see all the history of notifications he got".

## 2026-10-18 — Idea round: more gamification, interaction, customization (not yet processed)

- User: "the event owner can show the full name of the users in his platform, or only the username, or both. This is just an option, and our design should be flexible for all those changes or any options." (Note: this relaxes FR-120 / ADR-032, which show only username and avatar; needs a consent line on the join card and counsel input.)
- User asked Claude to "think with me": suggest more ideas for gamification, interaction and customization, so no good feature is missed. Candidate list and the user's picks: `_blueprint/WIREFRAME_REVIEW.md` (Idea round). Still pending approval.

## 2026-10-20 — Email sending (processed into ADR-112, INTEGRATIONS, TASKS T-021)

- User: "to send emails I want to use Gmail API not gmail password, and I want it to have spf dkim dmarc and
  anything more to make sure it's not go to spam."
- Answers: Google Workspace on our own domain (recommended option); the domain is `questify.nafes.com`.
- 2026-10-20, later: "questify.nafes.com is the dashboard domain and questify@nafes.com is the send from email." Checked in public DNS: `nafes.com` already runs Google Workspace (Google MX), with SPF `include:_spf.google.com`, a 2048-bit Google DKIM key, and DMARC `p=none` reporting to `dmarc@nafes.com`; DNS is on Cloudflare. ADR-112 and the RUNBOOK were updated to match.

## 2026-10-20 — Autonomous build while the user is away (processed into STATE and the work order below)

- User: "I will now have to go for a few days and I would like you to keep going. For now, I will not provide
  you the Apple and Google account, so you can skip those part. And any part that requires my things like the
  SMS, that I will provide it to you later. For now, I would like you to focus more on the development and for
  the requirements of the system, the functions itself, the design system, go with the design system that we
  already have right now. The adventure one, but keep it flexible to be changed later to another completely
  design. So don't do something like it's hard coded. And try to do as much as work as possible without
  waiting and needing my input."
- "Push whatever you have now into Git. Then start working on the new phases. … Try to use the CTO cycle as
  much as you can in the most important things. … Do your plan, validate it, do it, test it."
- Processed: skip T-010 (store accounts) and T-013 (SMS quotes); build SMS behind its adapter with a fake until
  Msegat credentials arrive; the design system is the adventure theme behind swappable theme tokens (no colors,
  fonts or shapes hard-coded in screens); CTO cycle on the core tasks. Decisions that are the user's stay
  `Proposed` and go to OPEN_QUESTIONS for the user's return.

## 2026-10-21 — Text size → processed

- "there is no accessibility settings in our app, its one font, one size and its the same for all users, we accept
  this" (during T-116, on whether the ranking's rows may cap large text).
- Processed: ADR-121 (Accepted); the app ignores the phone's text size everywhere; Reduce Motion stays (FR-408).

## 2026-10-21 — Pending items walk-through → processed

- "lets start by this Expo sign-in then Msegat volume quote and for Staging infrastructure, I dont want staging for
  now, only production"
- "A domain for the Resend email backup I want the same as gmail but lets skip this for now, gmail is enopgh if it
  dont go to spam"
- Answers, one by one: ADR-113, 115, 116, 120 accepted. ADR-114: "Questify doesnt do quests for other events at all,
  each event have its own things. Questify can do quest for questify it self, our home main page not inside the
  events". The coin "+": remove it. iOS 16.4: yes. Location: "whenever the app is open". Old usernames: "from the
  quesrify admin we can set this as 0 days = free at once or x days". Brand in Arabic: keep Latin "Questify",
  everywhere. Billing: follow ADR-076. Bar order: update the FR text. Exclusions, 404 page, quest fields, event info:
  Claude's recommendations. Sounds: "use free sounds that match our theme and style, we would need much more than 3
  sounds I guess". First event: no pilot yet. Trademark: "no need to have trademark"; check the store names. Mascot:
  Saqr. Staging: make the existing services production. Expo: start the Android development build.
- Processed: ADR-113 to 116 and 120 Accepted; ADR-123 to ADR-132; ADR-019 superseded; ADR-072 confirmed; FR-620,
  FR-830 and NFR-008 amended; Q-083, Q-077, Q-022 updated; 15 questions closed. Expo was already signed in; the
  first Android development build was started (`expo-dev-client` added, which the profile needs).

## 2026-10-22 — SMS test, store name, ADR-122 and ADR-133 → processed

- "for the SMS thing, no need for a volume quote right now. We already have a subscription there and account."
- SMS test: the real test after go-live (production with the new code, then sign in on the app with Dhia's number).
- Store name: "give me 10 options here in the chat and I will pick and tell you later" (ADR-131).
- ADR-122 and ADR-133: accepted.
- First Android development build finished (EAS a1411217, APK on expo.dev).
- Processed: Q-034's volume quote is dropped for now; ADR-122 and ADR-133 marked Accepted in DECISIONS.md (that
  file is committed with T-201/T-202, which another session has open).

## 2026-10-22 — Spending and the ranking → processed

- "if the when you buy something, will you have your points with you? Like, or you will lose them on the leaderboard
  and you get down. I think each event could have its own thinking or way. So let's make it an option for them."
- Processed: ADR-134 (Accepted), FR-1847; ADR-043 amended. Off by default; locked once the event is live (Claude's
  assumption).

## 2026-10-22 — Operators and My QR (T-204, T-205)

- "how much in % is done yet? do the next 2 tasks" (T-204 and T-205, one session).
- Operator invites: "send email only".
- My QR: "what if we made the QR not rotate? like its just fix, what are pros and cons?", then "Fixed code with
  verivaction, like he cannot just get the prize with just showin the QR, he must redeem it or accept it from his
  account".
- Operator bar: all five tabs now, unbuilt ones "coming soon".
- Station limits: "by defulte the operator have acsses to all, but then yes it could be limited by quest or both, you
  do what you think is best".
- Processed: plan `docs/plans/2026-10-22-t-204-t-205-operators-and-my-qr.md`; ADR-137 (fixed My QR, Accepted),
  ADR-138 (Proposed); FR-306, FR-307, FR-901 amended; Q-107 (booths).

## 2026-10-23 — Prize desk (T-206)

- How the player confirms a handover: "we have the 2 options, in the event settings the owner chooses" (player taps
  Collect first, or the desk offers and the player accepts).
- Undo after Handed over: drop it.
- Desk hours: "having a disk hours is optional things. Like by default, it is open all the time. But he can make it
  like on and off. And it applies to all the rewards." Several time windows.
- Processed: plan `docs/plans/2026-10-23-t-206-prize-desk.md`; ADR-150 (Accepted); FR-1716, FR-1717 amended. "All the
  rewards" read as every reward that goes through the desk (items and experiences); digital codes keep FR-1717
  (Claude's reading).

## 2026-10-23 — T-207 interview (manual awards)
- Caps: "Event caps only". A removed quest: stays used. Bulk award now: an uploaded list and a quest's completers.
  Who removes: owner and editors.
- Processed: ADR-152 (Accepted); plan `docs/plans/2026-10-23-t-207-manual-awards.md`.

## 2026-10-24 — NFC tags (T-308)
- Q-198 (signed tags): "we will go only with [basic tags]. The other option we will not do it at all. So remove it
  from the plans, remove it from everything."
- Processed: Q-198 answered; ADR-235 and ADR-236 rejected (titles kept); ADR-234 and ADR-237 cover basic tags only;
  ADR-040 stands; T-308b deleted from TASKS; the plan's signed-tag section removed; Q-200 closed as moot.

## 2026-10-25 — Model routing and independent reviews

- "Use GPT-6.1 Sol for everything (pinned in config.toml). Reasoning effort: High for coordinator, all plans,
  all reviews and core builds (Max only riskiest reviews); Medium standard builds; GPT-6 Luna (High) fine purely
  mechanical edits. Every review fresh session/subagent, never code author."
- Processed: ADR-265 (Accepted), `CLAUDE.md` and `docs/agents/WORKER_BRIEF.md`; preserved historical
  records. The existing `config.toml` already pins `gpt-6.1-sol` with High reasoning; no config change needed.
- "Keep building; deploy later" (when asked whether to deploy CranL migrations 0057–0062 and make a new Android
  build now). Continue building; defer that deployment and Android build.
- Processed: handoff and current queue in `docs/_blueprint/STATE.md` updated with the deployment deferral.

## 2026-10-25 — Resume after usage limits reset

- Dhia: “You might get out of tokens after a little because we are in short right now. But I would like you to give yourself a task or a ping when the limit is reset. It will reset in about five and fifty minutes. So can you just do that? So whenever the limit resets, you keep continuing. Is that possible? And you should do that each time if it's possible.”
- Processed: coordinator created heartbeat `resume-questify-after-usage-resets`; first wake 05:50 Asia/Riyadh, after
  the actual account reset at 2026-10-25 05:44:06 Riyadh. Reschedule the same heartbeat against each future actual
  reset; no API-credit purchase or reset-credit workaround. Keep building; deploy later. Preserve active T-402 work and fresh-review gates on resume.


## 2026-10-25 - Progress and continuation

- Dhia: "how much did we finish so far in %? and please keep going"
- Processed: confirmed75/153 tasks (49.02% by task count); continue coordinator queue, deploy later.


## 2026-10-25 - Requested break after current work

- Dhia: "When you finish what you have in your hand, please stop for a minute. I will tell you to. Please take a break and I will tell you when to go back."
- Processed: finish only the plan review already underway, save current evidence/next actions, then stop. Pause reset-resume heartbeat; no automatic continuation until Dhia explicitly resumes.


## 2026-10-25 - Resume after requested break

- Dhia: "keep working now"
- Processed: explicit resume revokes the break; continue the approved T-402b plan and restore the previously requested usage-reset wake-ups. Deployment and EAS builds remain deferred.

## 2026-10-26 - Break and handoff to a new Codex session

- Dhia: "okay finish your task on your hand then take a break, another ai agent will keep your work same codex but new session, so give me handoff short promit"
- Processed: save the current verified checkpoint and a concise takeover prompt, pause this chat's reset heartbeat,
  and stop. A new session may take over from the durable handoff; the unresolved independent-review gate is not
  waived, and no unreviewed implementation is pushed or marked complete.

## 2026-10-27 - Product manager and developer roles; sponsor terms
- Dhia: "this is your responsibility to decide what to do and to do it... If you need any help, ask the CTO. Don't stop
  for these questions that are unrelated to me. I'm just a product manager. You are the developer." Processed: CLAUDE.md
  coordinator rule 6; ADR-272 to ADR-305 accepted by the developer under this delegation.
- Dhia, on sponsored daily challenges (Q-279): "Name only". Processed: Q-279 answered; ADR-311 stands.
- Dhia, on promotional quiet hours (Q-287): "SMS only". Processed: Q-287 answered; push and email follow ADR-065.
- Dhia, on the daily word lists (Q-281): "Open lists + our picks". Processed: Q-281 answered; task T-406d added.
- Dhia, on Questify-wide ranking seasons (Q-292): "Automatic monthly". Processed: Q-292 answered; FR-1786 amended
  (each month resets by itself at 04:00 Riyadh time on the 1st, the console shows past months, no admin reset); ADR-323.
- Dhia: "when you finish what you have in your hand please take a break so I can compact and switch to Sonnet model". Processed: finish T-408b (build, review, push) and the T-408 mutation result, refresh the handoff, then stop; T-408c is not started.
