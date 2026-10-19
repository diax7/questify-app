# Questify: Gamification Patterns

Researched 2026-10-16. A design reference for quests, points, leaderboards and rewards at physical,
virtual and workplace events. Sources are linked inline; competitor detail is in `COMPETITORS.md`.

**Core principle from the evidence:** gamification works when it rewards the behavior the event
actually wants (meeting people, visiting sponsors, attending sessions) and keeps everyone, not just
the top 10, in reach of a reward. Bizzabo puts it bluntly: points for actions "that add little
value" do not move the needle ([Bizzabo](https://www.bizzabo.com/blog/smart-badge-event-gamification)).

---

## 1. Proven mechanics: when they work, when they backfire

| Mechanic | Works when | Backfires when | Questify guidance |
|---|---|---|---|
| **Points / XP** | Values are shown up front and tied to effort; rules are transparent. A review of leaderboard studies found clear point rules improved motivation, and unclear scoring made students ignore the board ([Li et al. 2024](https://doi.org/10.1111/jcal.13077)) | Points are given for trivial taps (profile views, opening the app), so they inflate and feel meaningless | Organizer-named currency; show "+50" on every quest card; cap repeatable actions (Cvent's min/max model, [Cvent](https://support.cvent.com/s/communityarticle/Setting-Up-and-Managing-the-Attendee-Hub-Game)) |
| **Levels** | Thresholds are frequent early, wider later; each level unlocks something visible | Levels are cosmetic, or jumps feel arbitrary | 5–7 levels per event; level-ups unlock store tiers or bonus quests |
| **Badges** | They mark meaningful milestones (Klik: "attended 10 AI sessions") and can be sponsored ([Bizzabo](https://www.bizzabo.com/blog/smart-badge-event-gamification)) | Dozens of badges for everything; badge clutter | Few, sponsor-able, 3D; show locked silhouettes to signal what's possible |
| **Streaks** | The habit is daily and the bar is low. Duolingo split streak from daily goal: +3.3% D14 retention ([Duolingo](https://blog.duolingo.com/improving-the-streak/)); 7-day streak learners are 3.6× likelier to finish ([Duolingo](https://blog.duolingo.com/how-duolingo-streak-builds-habit/)) | Breaking a streak demotivates; fear of losing it stops people starting (Duolingo admits both) | Use **per-day streaks only for multi-day events and corporate seasons**; one quest keeps the streak; give a free "freeze" |
| **Leagues / tiers** | Players are matched with peers of similar activity. Duolingo leagues: +17% learning time, 3× highly engaged users ([Lenny's](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth)). An RCT found small similar-score leaderboard groups lifted low performers ([Chen et al. 2024](https://ideas.repec.org/a/eee/labeco/v90y2024ics0927537124000976.html)) | One global board of 5,000 people: anyone outside the top 50 is invisible. Motivation peaks near rank ~10 and falls below that ([Leung 2019](https://doi.org/10.1145/3290605.3300397)) | Show "your bracket" (you ±5) by default plus the global top 10; daily or session resets (Airmeet supports resets, [help](https://help.airmeet.com/support/solutions/articles/82000879896-how-to-set-up-leaderboard-on-airmeet-to-maximize-attendee-engagement-)) |
| **Teams** | Shared goals across departments or strangers; team-size multipliers reward full rosters ([Eventus](https://eventus.host/)) | One strong player carries the team; free-riders | Team score = sum of capped individual points; team quests that need 3+ members |
| **Quest chains** | Step N unlocks N+1; tells a story through the venue. Goosechase reviewers ask for exactly this ([Software Advice](https://www.softwareadvice.co.nz/software/374188/goosechase)) | Chains are long and a single broken step (missing QR, closed booth) blocks everything | Short chains (3–5 steps); organizer can skip a broken step live |
| **Unlockables** | Hidden "secret code" quests create curiosity. Webex: a list of "Secret code 1, 2, 3" makes people determined to solve them ([Webex](https://help.webex.com/en-us/article/mxhsey/Game-Best-Practices)) | Too many hidden items feel like guesswork | Mix visible and hidden quests; drop hints by push |
| **Scarcity** | Real limits: the first 50 to finish get a shirt; store stock is honest. EventMobi's sweatshirts "were the first thing to run out" ([case study](https://go.eventmobi.com/hubfs/Hosted/EN/GetWellNetwork-Case-Study.pdf)) | Fake countdowns or fake low-stock. The FTC lists false timers as a dark pattern ([FTC](https://www.ftc.gov/news-events/news/press-releases/2022/09/ftc-report-shows-rise-sophisticated-dark-patterns-designed-trick-trap-consumers)) | Show true stock counts; never fake urgency |
| **Social proof** | "312 people found this booth" or a live feed of completions pulls others in | Public naming of low scorers. Low-ranked students prefer anonymity ([Bai et al. 2021](https://dl.acm.org/doi/abs/10.1016/j.compedu.2021.104297)) | Celebrate counts and top performers; let anyone play under a nickname |
| **Progress visualization** | Rings, bars and maps make the remaining path obvious (InEvent's "progress/health bar", [InEvent](https://inevent.com/en/gamification-in-events.php)) | Progress toward something unreachable (0.2% of the way to the grand prize) | Always show the **next reachable reward** in the store, not just rank |
| **Variable rewards** | Surprise bonuses for doing real things (Webex's "OOPSIES" code after a schedule mistake, [Webex](https://help.webex.com/en-us/article/mxhsey/Game-Best-Practices)) | Random paid loot. Chance-based prizes tied to purchase are banned in Saudi Arabia ([Ministry of Commerce](https://mc.gov.sa/ar/mediacenter/News/Pages/20-03-24-01.aspx)) | Surprise drops are fine; no paid spins, no purchase-linked chance |

**Watch the side effects.** In the leagues RCT, high performers enjoyed it but scored lower on the
exam than the control group ([Chen et al.](https://ideas.repec.org/a/eee/labeco/v90y2024ics0927537124000976.html)).
A game can pull effort away from the real goal. Weight quests toward the event's purpose, not toward
whatever is easiest to count.

---

## 2. Event-specific patterns

| Pattern | Design | Verification | Pitfalls | Evidence |
|---|---|---|---|---|
| **Sponsor booth visits** | Higher points for higher sponsor tiers; a "passport" of booths; a second, bigger reward for a real conversation (lead scan) | Public QR for the visit plus a staff-held code for the conversation ([Webex](https://help.webex.com/en-us/article/mxhsey/Game-Best-Practices), [Eventus](https://eventus.host/)) | Scan-and-run with no talk; sponsors feel spammed | Satoshi Quest: 220+ booth visits, over half of points sponsor-tied ([LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7487768891763482625)) |
| **Session check-ins** | Code on the last slide or spoken by the speaker; bonus for answering a recall question | Rotating QR on the screen; time window = session time; one check-in per overlapping slot | Checking into three parallel sessions at once (a real Goosechase complaint, [reviews](https://appsupports.co/437330879/goosechase/negative-reviews)) | EventMobi: codes on final slides ([case](https://go.eventmobi.com/hubfs/Hosted/EN/GetWellNetwork-Case-Study.pdf)) |
| **Networking quests** | Each attendee has a personal code or QR; "meet 5 people from another company"; first-timer bonus | Two-sided: both scan each other; daily pair cap; no repeat pairs | Badge-scanning sprees with no conversation | Klik: 25 exchanges per attendee on average ([Bizzabo](https://www.bizzabo.com/blog/klik-wearable-event-technology-drives-400-increase-in-exhibitor-leads)); codes on badges as icebreakers ([EventMobi](https://www.eventmobi.com/gamification/)) |
| **Scavenger hunts** | Themed chains through the venue; photo, QR, GPS and trivia mixed | QR + moderation for photos; GPS only outdoors | Codes removed or damaged; generic photo prompts ("a stranger by a lamppost") feel cheap ([reviews](https://appsupports.co/437330879/goosechase/negative-reviews)) | Riyadh Season Treasure Hunt: 100k+ downloads, staggered drops to stop cheating ([UNIT9](https://www.unit9.com/project/riyadh-season-treasure-hunt/)) |
| **Live voting / quiz** | Points for taking part; bonus for correct, speed-weighted answers; final team vote for "best team" ([Eventus](https://eventus.host/)) | One answer per device; window closes on the host's tap | Multiple-choice re-guessing until right ([Capterra](https://www.capterra.com/p/198630/GooseChase/reviews/)) | Webook's live song voting at concerts ([Asharq Al-Awsat](https://english.aawsat.com/business/5055768-webook-boost-saudi-entertainment-sector-profits)) |
| **Big-screen leaderboard** | Projected top 10–21 plus a live completion feed, photo wall and "biggest climber" | Hide flagged users until reviewed | Same names all day = boredom; showing only top 3 | EventMobi shows the top 21 on screen ([help](https://help.eventmobi.com/en/knowledge/what-is-gamification)); live drawings on screen ([Webex](https://socio.events/features/event-gamification-app)) |

**Revenue patterns organizers already sell:** sponsored quests, branded checkpoints, leaderboard
naming rights, sponsored badges, prize sponsorship with logo on the winner screen ([Airmeet](https://www.airmeet.com/hub/virtual-event-gamification/),
[Bizzabo](https://www.bizzabo.com/blog/smart-badge-event-gamification),
[LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7487768891763482625)).

---

## 3. Anti-cheat for QR and check-in quests

Single signals fail; layered cheap signals hold. A 2026 study of anti-proxy attendance combining a
rotating TOTP QR, Bluetooth proximity and a device lock blocked 11 of 12 simulated attacks
([Bhavnagri 2026](https://doi.org/10.22214/ijraset.2026.84589)).

| Threat | Control | Strength | Cost and caveats |
|---|---|---|---|
| Photo of a printed QR shared in a group chat | **Rotating QR** on a screen (signed token, 30–60s life). Static printed QR only for low-value quests | High | Needs a powered screen or tablet per station ([GoValid example](https://my.govalid.org/guide/instant-checkin/)) |
| Code passed by word of mouth (EventMobi/Webex passcodes) | **One-time codes** per attendee, or codes bound to a time window | Medium-high | More codes to print or display |
| Scanning without doing the task | **Two-step booth flow:** public instruction QR, then a hidden staff validation QR or staff scanning the attendee's QR ([Eventus](https://eventus.host/)) | High | Booth staff must be briefed; give them a staff mode in the app |
| Remote check-in | **Geofence** as a soft signal: flag, don't block. Indoor GPS is unreliable (Actionbound's GPS complaints, [Check-App](https://www.check-app.de/2024/12/20/actionbound-die-idee-die-nutzer-frustriert-und-warum-die-bewertungen-so-niedrig-sind/)). BLE beacons or venue Wi-Fi are stronger indoors | Medium | Location permission prompt; PDPL consent needed |
| GPS spoofing / mock location | OS mock-location flags; **device integrity** via [Apple App Attest](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity) and [Google Play Integrity](https://developer.android.com/google/play/integrity) | Medium-high | Fail soft for older devices |
| Fake photo submissions (Goosechase: "palm of my hand... 200 points", [reviews](https://appsupports.co/437330879/goosechase/negative-reviews)) | **Moderation queue**: approve/reject, as Eventzee and InEvent do ([Eventzee](https://eventzeeapp.com/new-ready-made-party-packs-make-event-planning-a-snap/), [InEvent FAQ](https://faq.inevent.com/l/en/inevent-live/gamification)); points stay pending until approved; optional AI pre-screen | High | Moderator workload; set an SLA and auto-approve low-value quests |
| Multiple accounts / one person, many phones | Login tied to ticket or verified phone; one active device per account | High | Shared family devices at consumer events |
| Grinding repeatable actions | Per-action caps and daily caps (Cvent max repeats; Airmeet ≤100 points per activity, [help](https://help.airmeet.com/support/solutions/articles/82000879896-how-to-set-up-leaderboard-on-airmeet-to-maximize-attendee-engagement-)) | High | None |
| Brute-forcing codes or quiz answers | **Rate limits** per user and device; one attempt per quiz question; codes long enough not to guess (Webex: avoid sponsor names, [Webex](https://help.webex.com/en-us/article/mxhsey/Game-Best-Practices)) | High | None |
| Impossible patterns (two booths 400m apart in 10s; 3 sessions at once) | **Anomaly rules** and auto-flagging before a score reaches the board, as Strava does ([Strava](https://communityhub.strava.com/what-s-new-10/keeping-leaderboards-fair-more-leaderboard-improvements-8009)) | Medium-high | Tune thresholds per venue |
| Staff or organizer relatives winning | **Exclusion list** by email domain (Airmeet does this); required for Saudi prize draws ([Asharqia Chamber](https://www.chamber.org.sa/en/subscribers/business-service/)) | High | Organizer setup step |
| Disputes after prizes are paid | **Append-only points ledger** with reason, quest, device and timestamp (Beast Land tied every interaction to a verified identity, [Flash Pack](https://itstheflashpack.com/case-studies/powering-beast-land-with-a-large-scale-gamified-digital-experience/)); export for audit (Webex used exports to disqualify, [guide](https://help.webex.com/en-us/article/mxhsey/Game-Best-Practices)) | High | Storage only |

**Sanctions:** use a graduated policy like Niantic's three strikes (warning → suspension → ban),
plus an appeal path ([Niantic](https://niantic.helpshift.com/hc/en/6-pokemon-go/faq/39-gameplay-fairness-policy-1701994322/)).
For a one-day event, use: flag, hold the points, then a moderator decides.

**Connectivity is part of fairness.** Venue networks fail. Goosechase users lost unsent photos
offline and saw the live leaderboard break ([App Store](https://apps.apple.com/us/app/goosechase/id437330879?platform=iphone&see-all=reviews),
[Software Advice](https://www.softwareadvice.co.nz/software/374188/goosechase)). Scavify lets
people upload later ([App Store](https://apps.apple.com/us/app/scavify/id799741525)). Queue
submissions offline with a signed timestamp; validate rotating-QR tokens against capture time.

---

## 4. Sustaining engagement past the first hour, and after the event

| Phase | What works | Source |
|---|---|---|
| **Before** | Codes in registration emails; early-bird quest that switches off once early birds land; "complete your profile" and "build your agenda" missions | [Webex](https://help.webex.com/en-us/article/mxhsey/Game-Best-Practices), [Whova](https://whova.com/blog/leaderboard-gamification-audience-participation/) |
| **First hour** | Reveal the first code live in the opening keynote so the whole room scores together; game widget and leaderboard on the home screen | [EventMobi case](https://go.eventmobi.com/hubfs/Hosted/EN/GetWellNetwork-Case-Study.pdf) |
| **Mid-event slump** | Timed drops ("next 30 minutes, Hall B booths double"); codes hidden in push announcements; per-session or per-day resets so late joiners can still win | [Webex](https://help.webex.com/en-us/article/mxhsey/Game-Best-Practices), [Airmeet](https://www.airmeet.com/hub/virtual-event-gamification/) |
| **Catch-up** | Bracket leaderboards; "most improved" and team prizes; store rewards everyone can reach, so rank is not the only payoff | [Chen et al.](https://ideas.repec.org/a/eee/labeco/v90y2024ics0927537124000976.html) |
| **Finale** | Big-screen countdown, winner reveal with sponsor logos, final vote | [Airmeet](https://www.airmeet.com/hub/virtual-event-gamification/) |
| **After** | Personal **recap story**, Wrapped-style (Spotify Wrapped 2025: 200M+ users in 24h, [TechCrunch](https://techcrunch.com/2025/12/04/spotify-says-wrapped-2025-is-its-biggest-yet-with-200m-users-in-its-first-day/)), with shareable cards; a redemption window of a few days for the store; community that stays open (Whova's strength, [Capterra](https://www.capterra.com/p/149712/Whova/)) | |
| **Across events** | Persistent profile, lifetime level and badge shelf; corporate "seasons" with weekly missions (Novo Nordisk KSA ran 5 missions over 5 weeks, [ECHT](https://echt.me/projects/qr-treasure-hunt-team-building-activity-rebel-mission)) | |

Benchmarks for participation: EventMobi's CSAE case saw ~20% of attendees play
([PDF](https://go.eventmobi.com/hubfs/Hosted/EN/CSAE-Case-Study.pdf)); a well-run overlay hit 72%
activation ([LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7487768891763482625)).
Promotion and onboarding, not the mechanics, make the difference.

---

## 5. Ethics and dark patterns to avoid

| Avoid | Why | Do instead |
|---|---|---|
| Chance-based prizes tied to purchase; paid spins, loot boxes | Lottery-style prizes are banned in Saudi Arabia; purchase cannot be required for a prize draw ([MC](https://mc.gov.sa/ar/mediacenter/News/Pages/20-03-24-01.aspx)) | Skill and participation-based points; any draw is free entry |
| Running prize draws without a license | Draws need a Chamber license and Ministry supervision; max 60 days; prizes within 7 days of results; penalties up to SAR 1M ([MC](https://mc.gov.sa/en/mediacenter/News/Pages/21-09-25-01.aspx), [Asharqia](https://www.chamber.org.sa/en/subscribers/business-service/)) | Built-in draw checklist (license number field, staff exclusion, result-announcement template) |
| Celebrating frequency of risky or costly actions | Robinhood paid a $7.5M fine and agreed to drop confetti tied to trading frequency and game-of-chance features ([Massachusetts](https://www.sec.state.ma.us/divisions/news/enforcement-news.htm)) | Celebrate real achievements (quest done, level up), never spending |
| Fake timers, fake stock, pre-ticked consent, hard opt-out | FTC dark-pattern categories ([FTC report](https://www.ftc.gov/system/files/ftc_gov/pdf/P214800+Dark+Patterns+Report+9.14.2022+-+FINAL.pdf)) | Honest stock and deadlines; one-tap leave game (Cvent keeps points when users opt out, [Cvent](https://support.cvent.com/s/communityarticle/Setting-Up-and-Managing-the-Attendee-Hub-Game)) |
| Notification spam | Whova's top complaint: 72% negative of 113 reviews on notifications ([Capterra](https://www.capterra.com/p/149712/Whova/)) | Budget pushes per attendee per day; quiet hours; per-topic mute |
| Shaming low ranks | Low-ranked users prefer anonymity ([Bai et al.](https://dl.acm.org/doi/abs/10.1016/j.compedu.2021.104297)) | Nicknames, bracket boards, opt-out of the public board |
| Streak anxiety | Broken streaks demotivate ([Duolingo](https://blog.duolingo.com/how-duolingo-streak-builds-habit/)) | Freezes; no guilt-trip copy ("Duo is sad") |
| Collecting data beyond purpose | PDPL needs specific, documented, per-purpose consent; explicit consent for sensitive data; limits on transfer abroad ([SDAIA](https://sdaia.gov.sa/en/SDAIA/about/Documents/ImplementingRegulation.pdf)) | Separate consents for location, photos and sponsor lead sharing; in-Kingdom hosting option |
| Forcing photos of people | Privacy and cultural norms in mixed groups | Photo quests of objects and places by default; consent prompt for people photos; women-only/men-only team options where the organizer wants them |
| Inaccessible motion | Vestibular issues, low-end devices | Respect the OS reduce-motion setting; static fallbacks |

Cultural note: Saudi draw procedures include pausing draw announcements at prayer time and a
separate space for women at draws ([Makkah Chamber form](https://www.makkahcci.org.sa/mc_theme_v5/static/src/docs/2d.pdf)).
The organizer should be able to schedule pauses (no timed drops during prayer) and turn mixed-team
rules on or off.

---

## 6. High-craft gamified UI and motion references

| Reference | What to study | Link |
|---|---|---|
| Duolingo streak celebration | Milestone animations raised D7 retention of new learners by +1.7% | [Duolingo blog](https://blog.duolingo.com/how-duolingo-streak-builds-habit/) |
| Duolingo × Rive characters | State machines blend visemes, idles and reactions at small file sizes | [World characters](https://blog.duolingo.com/world-character-visemes/), [Lily video call](https://rive.app/blog/duolingo-s-ai-powered-video-call-brings-lily-to-life) |
| Duolingo "creative technologist" role | Animators ship real runtime assets; no designer-to-dev rebuild | [Rive blog](https://rive.app/blog/creative-technologists-duolingo-s-solution-to-the-designer-to-developer-handoff) |
| Duolingo design blog | Articles from Duolingo's design team on craft and process | [design.duolingo.com](https://design.duolingo.com/) |
| Rive | Interactive state-machine animation runtime for iOS, Android and web | [rive.app](https://rive.app/) |
| Lottie | JSON vector animations from After Effects | [airbnb.io/lottie](https://airbnb.io/lottie/) |
| Microsoft Fluent 3D emoji | Open-source (MIT) 3D icon style, good for prototyping | [GitHub](https://github.com/microsoft/fluentui-emoji) |
| Apple HIG: Motion | Purposeful motion, reduce-motion handling | [Apple](https://developer.apple.com/design/human-interface-guidelines/motion) |
| Material 3 Expressive motion | Physics-based (spring) motion system introduced May 2025 | [m3.material.io](https://m3.material.io/styles/motion/overview) |
| Spotify Wrapped | Story-format recap with share cards; "Wrapped Party" group mode | [Spotify newsroom](https://newsroom.spotify.com/2025-12-03/2025-wrapped-user-experience/) |
| Starbucks Rewards 2026 | Visible tier progress, clear redemption ladder (25 → 400 Stars) | [Starbucks](https://about.starbucks.com/press/2026/starbucks-unveils-reimagined-loyalty-program-to-deliver-more-meaningful-value-personalization-and-engagement-to-members/) |
| Duolingo reward chests | First Rive use: chest shaking, gems bursting out | [Rive blog](https://rive.app/blog/creative-technologists-duolingo-s-solution-to-the-designer-to-developer-handoff) |

### Motion rules distilled for Questify

1. **Every point gain is felt:** a number that counts up, a coin flying to the balance, a light
   haptic. One small animation per action. Save the big ones for rarer moments.
2. **Celebration scales with rarity:** quest done = small; level up = medium; store redemption or
   finale = full-screen. Duolingo's data says milestone moments carry the retention effect.
3. **Progress is always on screen:** next reward, level ring and bracket rank on the home screen.
4. **One animation system, data-driven:** state machines (Rive) let one asset respond to rank,
   level and team color, so white-label theming doesn't need new animation files.
5. **Budget for real devices:** Lily's full Rive file is under 1 MB
   ([Rive](https://rive.app/blog/duolingo-s-ai-powered-video-call-brings-lily-to-life)). Target
   low-end Android at crowded venues, and honor reduce-motion.
6. **RTL-aware motion:** progress bars, swipes and "fly to balance" paths must mirror in Arabic.
   Numerals, currency names and celebration copy must be localized, not translated literally.
