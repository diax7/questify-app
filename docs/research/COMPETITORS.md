# Questify: Competitor Research

Researched 2026-10-16 with Exa web search. Every non-obvious claim links its source. Prices are
list prices or third-party estimates as found on that date; most enterprise vendors quote privately,
so treat any figure marked *(est.)* as a rough guide only.

## 0. Market changes to know first (staleness flags)

| Change | Date | What it means for Questify | Source |
|---|---|---|---|
| Hopin's event product became **RingCentral Events** | 2023 | Virtual-first; gamification through third-party integrations only | [RingCentral blog](https://www.ringcentral.com/us/en/blog/ringcentral-events/) |
| **Webex Events (ex-Socio)** stopped standalone sales; serves only Webex Suite Enterprise Agreement customers | Apr 2024 / Apr 2025 | Not a live competitor for new organizers | [Socio update](https://whatsnew.socio.events/important-update-upcoming-changes-to-webex-events-subscriptions-purchasing-options-ED7na), [Cisco EoL](https://www.cisco.com/c/en/us/products/collateral/unified-communications/cisco-collaboration-flex-plan/webex-event-standalone-virtual-ser-eol.html) |
| **Hubilo** acquired by Brandlive, rebranded **VirtualPRO by Brandlive**; had pivoted to webinars | Sep 2025 / 2026 | Out of the in-person gamification race | [GlobeNewswire](https://www.globenewswire.com/news-release/2025/09/16/3150896/0/en/brandlive-acquires-hubilo-to-accelerate-ai-and-enterprise-video-innovation.html), [Skift May 2026](https://meetings.skift.com/2026/05/04/event-tech-ai-news-may-2026/) |
| **Cvent** (Blackstone-owned) bought Goldcast and ON24 (~$700M) | Dec 2025 – H1 2026 | Cvent is consolidating virtual/webinar; in-person gamification is not its focus | [Skift 2025 roundup](https://meetings.skift.com/2026/01/08/2025-event-tech-ai-news-roundup/) |
| **Eventbrite** acquired by Bending Spoons ($500M) | Dec 2025 – Mar 2026 | Expect cost cuts at a major ticketing player | [Skift](https://meetings.skift.com/2026/01/08/2025-event-tech-ai-news-roundup/) |
| **Bizzabo** owns **Klik** smart badges (acquired 2021); launched "Bizzy" AI attendee copilot | 2021 / 2026 | Bizzabo's gamification runs on its hardware | [Bizzabo](https://www.bizzabo.com/blog/bizzabo-acquires-klik), [Skift](https://meetings.skift.com/2026/05/04/event-tech-ai-news-may-2026/) |
| **Eventtus** (Egypt, MENA's best-known event app) acquired by Bevy | Jul 2021 | No strong independent MENA event-app incumbent | [TechCrunch](https://techcrunch.com/2021/07/14/events-platform-bevy-acquires-egypts-eventtus-to-scale-its-offering-for-enterprises/) |
| **Airmeet** still ships (Sept 2026 release notes), now framed around webinars and AI clips | 2026 | Mainly virtual | [Airmeet notes](https://help.airmeet.com/support/solutions/articles/82000927830-airmeet-product-release-notes-september-2026) |

**Saudi market context:** over 17,000 business events in a single year, and Riyadh Season drew 20M+
visitors in one season ([Arab News, Nov 2025](https://www.arabnews.com/node/2621130/%7B%7B)). Saudi
Arabia had 923 venues as of late 2025 ([Kongres](https://kongres-magazine.eu/2025/12/saudi-trade-show-boom-tests-riyadhs-venue-capacity/)).

---

## (a) Full event platforms with gamification modules

The pattern across this category: gamification is one module inside a large app. It is either
**auto-tracked in-app actions** (post, message, add session), **typed passcodes**, or **scanned QR
codes**. The prize is almost always "top N on the leaderboard win", not a store where everyone spends.

### Whova
- **What:** All-in-one event app plus registration, strong community board. 50,000+ events ([pricing page](https://whova.com/pricing/)).
- **Gamification:** Leaderboard contest with points for posting, commenting, polls, surveys, sharing articles, adding sessions; photo and caption contests; trivia with AI question generator; session-attendance "stamps" ([attendee guide](https://whova.com/pages/how-to-participate-event/), [gamification page](https://whova.com/whova-event-app/event-gamification-app/), [help center](https://whova.zendesk.com/hc/en-us/sections/23170162187931-Virtual-Attendee-Gamification)).
- **Rewards:** Organizer writes a prize description; winners picked manually or at random; announced by push/email ([blog](https://whova.com/blog/leaderboard-gamification-audience-participation/)).
- **Verification:** Mostly automatic (in-app actions). Little physical-world verification.
- **White-label:** Branded content; built-in section titles and icon names cannot be translated from English ([FAQ](https://whova.com/faq/does-whova-support-languages-other-than-english/)).
- **Pricing:** Quote. A public 2024 county contract shows a $2,299 book price for the Standard package (up to 500 attendees) ([Lancaster County PDF](https://www.lancaster.ne.gov/DocumentCenter/View/26114/C-24-0912-PDF)); paid tickets cost 3.0% + $0.99 *(est., [CheckThat](https://checkthat.ai/brands/whova/pricing))*. Non-refundable.
- **Platforms:** iOS, Android, web.
- **Strengths:** Community that stays alive after the event; easy for attendees.
- **Complaints:** Notification overload (72% negative of 113 reviews on that theme), confusing messaging, cluttered UI ([Capterra](https://www.capterra.com/p/149712/Whova/)).

### Cvent Attendee Hub
- **What:** Enterprise event app/site inside Cvent's suite.
- **Gamification:** "Game" with challenges made of actions; each action 1–100 points, with min/max repetitions; badges per challenge; QR codes downloadable per action; points deducted if an action is undone; leaderboard shows top 50, opt-in "join game"; game can run up to two years ([Cvent support](https://support.cvent.com/s/communityarticle/Setting-Up-and-Managing-the-Attendee-Hub-Game)).
- **Rewards:** None built in beyond badges and ranking.
- **Verification:** System events (registration, check-in) plus QR scan.
- **White-label:** Theme colors carried into badges; branded app.
- **Languages:** Cvent's supported list has no Arabic ([Cvent](https://support.cvent.com/s/communityarticle/Which-languages-does-Cvent-support)).
- **Pricing:** Quote; reviewers cite "high and complex pricing" ([Capterra](https://www.capterra.com/p/26318/Cvent-Event-Management/)).
- **Strengths:** Deep data integration; long-running games.
- **Complaints:** "All or nothing" product that confuses less technical attendees ([Gartner](https://www.gartner.com/reviews/product/cvent-attendee-hub)); bugs and complexity ([Capterra](https://www.capterra.com/p/26318/Cvent-Event-Management/)).

### Swapcard
- **What:** AI matchmaking and exhibitor platform for trade shows.
- **Gamification:** Native scoring is light; serious gamification comes via the **Captello** integration (scavenger hunts, trivia, e-gift cards, leaderboards on floor displays) ([Swapcard × Captello](https://www.swapcard.com/platform/integrations/captello)). Offers indoor positioning and geofencing notifications as an add-on ([pricing](https://www.swapcard.com/pricing)).
- **White-label:** "Branded app (Powered by Swapcard)" and "White Label app (no Swapcard mentions)" are paid add-ons ([pricing](https://www.swapcard.com/pricing)).
- **Languages:** Arabic supported, RTL in emails ([help](https://help.swapcard.com/en/articles/9800855-essential-event-setup-languages-formats-and-branding), [release](https://release.swapcard.com/expansion-to-21-languages-with-rtl-support-for-transactional-emails-1cHx4Y)).
- **Pricing:** Self-service from $610/year; annual only, no monthly, 90-day termination notice ([pricing plans](https://www.swapcard.com/pricing-plans)).
- **Complaints:** Platform instability at scale, dropped sessions ([Software Advice](https://www.softwareadvice.com/conference/swapcard-profile/)).

### Bizzabo (with Klik SmartBadges)
- **What:** "Event Experience OS"; owns Klik Bluetooth/NFC wearable badges.
- **Gamification:** Points for badge taps (contact exchange), dwell time in sessions or zones, touchpoints at sponsors; threshold badges; sponsor-funded badges; organizer can light up badge groups ([Bizzabo blog](https://www.bizzabo.com/blog/smart-badge-event-gamification)). Claims 500% networking lift with gamification ([Bizzabo](https://www.bizzabo.com/blog/klik-wearable-event-technology-drives-400-increase-in-exhibitor-leads)) (vendor data).
- **Verification:** Hardware proximity, the strongest in the category.
- **Pricing:** Quote; $499–$17,999/month *(est., comparison table on [CostBench's Brella page](https://costbench.com/software/event-management/brella/), low confidence)*. Hardware adds cost.
- **Complaints:** Long setup, rigid website builder, mobile app bugs, features sold but not included ([Capterra](https://www.capterra.com/p/135385/Bizzabo/reviews/)); attendees find the UI hard to navigate ([App Store](https://apps.apple.com/us/app/bizzabo/id408705047)).

### EventMobi
- **What:** Mid-market event app plus registration and badging.
- **Gamification:** Alphanumeric **passcodes** typed into the app (not case-sensitive, unique per challenge); hidden/reveal challenges; Excel import; leaderboard widget and a big-screen view of the top 21 ([help](https://help.eventmobi.com/en/knowledge/what-is-gamification)). Patterns: codes on the last slide, on badges, at booths, with higher points for top-tier sponsors ([page](https://www.eventmobi.com/gamification/)).
- **Rewards:** Case study: a customer ran a pop-up shop where points bought swag; sweatshirts sold out first ([GetWellNetwork PDF](https://go.eventmobi.com/hubfs/Hosted/EN/GetWellNetwork-Case-Study.pdf)). Redemption was manual. Another case: about 20% of attendees played ([CSAE PDF](https://go.eventmobi.com/hubfs/Hosted/EN/CSAE-Case-Study.pdf)).
- **Verification:** Weak. A code can be shared by word of mouth.
- **Pricing:** From $3,000 per event, or $8,900/year unlimited events ([pricing](https://www.eventmobi.com/pricing/)).

### Brella
- **What:** Networking and matchmaking app, white-label available ([help](https://help-organizers.brella.io/en/articles/177595-add-app-sponsor)).
- **Gamification:** No strong native module found. Third parties overlay it: "The Satoshi Quest" inside a Brella app got 850+ players, 72% activation, 4,200+ challenges, 220+ sponsor booth visits, and over half of 620,000 points tied to sponsors. It sold premium mission slots and leaderboard sponsorship ([LinkedIn, Jul 2026](https://www.linkedin.com/feed/update/urn:li:activity:7487768891763482625)).
- **Pricing:** Quote; pricing complaints for small events, no trial, limited integrations ([Techreviewer](https://techreviewer.co/products/brella)).

### Grip
- **What:** AI matchmaking app for trade shows; fully white-labeled ([Grip](https://www.grip.events/products/mobile-event-app)).
- **Gamification:** Through embedded Captello, not native ([Grip × Captello](https://www.grip.events/integrations-directory/captello)).
- **Pricing:** Quote (no public price found).

### Hubilo (now VirtualPRO by Brandlive)
- **Gamification:** Custom leaderboard with points per activity (profile views, booth views, sessions, social wall), photo/caption contests ([Hubilo blog](https://www.hubilo.com/blog/gamification-on-virtual-event-platform-a-guide-for-event-planners?a359e617_page=33)).
- **Status:** Virtual/webinar product inside Brandlive; not an in-person competitor (see section 0).

### Airmeet
- **Gamification:** Leaderboard, points per activity (max 100), **currency can be renamed**, 3–50 winners with sponsor logos on prizes, reset per day/session, exclude email domains (staff), hide the points "playbook". Points are **locked once the event starts** ([help](https://help.airmeet.com/support/solutions/articles/82000879896-how-to-set-up-leaderboard-on-airmeet-to-maximize-attendee-engagement-), [hub](https://www.airmeet.com/hub/virtual-event-gamification/)).
- **Fit:** Virtual-first; no physical verification.

### RingCentral Events (ex-Hopin)
- **Gamification:** No native engine. Uses Kahoot, Slido, and vSpace by Validar for leaderboards; custom CTA pop-ups in booths for "virtual scavenger hunts" ([RingCentral blog](https://www.ringcentral.com/us/en/blog/ringcentral-events/), [release notes](https://support.ringcentral.com/release-notes/mvp/video/events/release-notes-june-23-2023.html)).
- **Fit:** Virtual/hybrid; organizer check-in app for onsite ([support](https://support.ringcentral.com/article-v2/using-ringcentral-events-organizer-app.html?brand=RingCentral&language=en_US&product=Events)).

### Webex Events (ex-Socio)
- **Gamification:** Secret-code "Game" (25-character codes, uppercase), challenge export used to disqualify cheaters, "Game Wizard" staff role, drawings shown live on screen ([setup](https://help.socio.events/en/articles/2611283-game-feature-setup-guide), [best practices](https://help.webex.com/en-us/article/mxhsey/Game-Best-Practices)).
- **Status:** Not sold standalone (section 0). Its best-practice guide is still useful reading.

### InEvent
- **Gamification:** Up to 10 missions (scavenger hunt, trivia, quizzes, photo contests), virtual passport for booth visits, prize wheel, badges, progress/health bar, live display screens; missions can be **moderated** (Pending → Completed); points label renameable ([InEvent](https://inevent.com/en/gamification-in-events.php), [FAQ](https://faq.inevent.com/l/en/inevent-live/gamification)).
- **Rewards:** "Exchanging points for swag" is described as a customer favorite, but run by staff.
- **Pricing:** Quote.

### vFairs
- **Gamification:** Leaderboard (points for video views, downloads, webinars); scavenger hunt with QR codes onsite; spin the wheel; trivia ([features](https://www.vfairs.com/features/event-gamification/)). Notable: a **"Redeem Item" QR** that deducts points when scanned, a primitive redemption booth ([help](https://help.vfairs.com/knowledge/how-to-enable-and-manage-scavenger-hunt)).
- **Pricing:** Quote, no free plan, project manager on every plan ([pricing](https://www.vfairs.com/pricing/)). G2 4.7 from 1,758 reviews.
- **Complaints:** Complex backend, weak chat/analytics ([GetApp](https://www.getapp.com/customer-management-software/a/vfairs/)).

### Added: Captello (gamification engine used inside Swapcard and Grip)
- 60+ branded games (Spin to Win, Whack-a-Mole, trivia, waypoint QR hunts), every play becomes a scored lead, automatic gift-card rewards across 250+ international brands ([Captello](https://www.captello.com/activations-engagement), [library](https://www.captello.com/gamification-library)). Built for exhibitor lead capture, not attendee delight. Pricing by quote.

---

## (b) Dedicated gamification and scavenger-hunt apps

### Goosechase
- **Quests:** Missions of three kinds: text, GPS, photo/video; time-based mission release; bonus points; live submission feed ([Software Advice](https://www.softwareadvice.co.nz/software/374188/goosechase)). Joins by app or browser link, no download needed ([download page](https://goosechase.com/download)).
- **Verification:** Admin reviews submissions; by default a photo is accepted. One review: "I took a photo of the palm of my hand... and got 200 points" ([App Store reviews](https://appsupports.co/437330879/goosechase/negative-reviews)).
- **Rewards:** No store; prizes run outside the app.
- **Languages:** UI is **English only** as of Apr 2026 ([help](https://support.goosechase.com/en/articles/14488311-is-goosechase-available-in-different-languages)).
- **Pricing:** Free for 3 participants for 24h; single event (30 days) $99/10, $299/40, $499/100, $749/175; subscriptions by quote ([help, Sep 2026](https://support.goosechase.com/en/articles/4571290-how-much-does-a-goosechase-experience-cost)).
- **Complaints:** Price jumps, no camera zoom, guessing multiple-choice answers until correct, no mission chaining, connectivity breaks the live leaderboard, photos lost offline ([Capterra](https://www.capterra.com/p/198630/GooseChase/reviews/), [App Store](https://apps.apple.com/us/app/goosechase/id437330879?platform=iphone&see-all=reviews)).

### Scavify
- **Quests:** Unlimited challenge types; DIY, full-service, or ready-to-go hunts; scheduling ([pricing](https://www.scavify.com/pricing), [admin](https://www.scavify.com/features-admin)).
- **Rewards:** One custom reward shown when all challenges are done.
- **Branding:** Logos and banners; photo slideshow for big screens.
- **Pricing:** Free to start, quote for programs.
- **Complaints:** Event-only (no ongoing engagement), costly for occasional use, setup effort ([FitGap](https://us.fitgap.com/products/014142/scavify)); scrolling UI bugs ([App Store](https://apps.apple.com/us/app/scavify/id799741525)).

### Eventzee
- **Quests:** Photo, QR code, GPS, video, quiz, to-do; admin approves or rejects photos and videos; TV display ([pricing](https://eventzeeapp.com/pricing/), [party packs](https://eventzeeapp.com/new-ready-made-party-packs-make-event-planning-a-snap/)).
- **Pricing:** Contact sales; $49.99 premade Party Packs (25 players); per-player partner pricing for agencies. Pages date from 2020–2022: **possibly stale**.

### Loquiz
- **Quests:** 7 task types including augmented photo; map "playgrounds" with logic-driven pins; swap Loquiz branding for your own logo and colors; custom app languages ([pay per use](https://loquiz.com/support/pay-per-use/)).
- **Pricing:** Per team or player: €9/player pay-per-use (200 players/game max); packages like €250/month "Outdoor company", €500 "Event organiser" ([pricing](https://loquiz.com/pricing/), [2024](https://loquiz.com/pricing-2024/)). Pages are 2022–2024: **verify**.
- **Fit:** Outdoor team-building companies; strong logic; less polished consumer UI.

### Actionbound
- **Quests:** GPS "Bounds" with QR codes, quizzes, missions, tournaments ("Bound Challenge").
- **Pricing:** Free for private use; PRO priced by players: €350/50, €600/100, €900/200, €1,500/500, €2,250 for up to 2,500 at one location; multi-language add-on €350, styler €550 ([license](https://en.actionbound.com/license/business/1)).
- **Complaints:** 2.5 stars from 470+ Google Play reviews: GPS errors, crashes, outdated codes ([Check-App, Dec 2024](https://www.check-app.de/2024/12/20/actionbound-die-idee-die-nutzer-frustriert-und-warum-die-bewertungen-so-niedrig-sind/)).

### Others found
| Product | What stands out | Source |
|---|---|---|
| **Eventus** | Each booth gets a public instruction QR plus a **hidden staff validation QR**; team multipliers, rating bonuses, end-of-event voting | [eventus.host](https://eventus.host/) |
| **Captello** | See (a); the game library to beat for booth activations | [captello.com](https://www.captello.com/gamification-library) |

---

## (c) Live engagement tools (in-session, not event-wide)

| Tool | Gamification | Branding | Pricing (Oct 2026) | Notes and complaints |
|---|---|---|---|---|
| **Slido** (Cisco) | Quizzes with leaderboard, polls, upvoted Q&A | Branding on Professional (up to 1,000 participants) ([plan](https://www.slido.com/professional-plan)) | Pricing page needs JS; a May 2026 thread cites ~$60 Engage vs ~$240 Professional one-time ([community](https://community.slido.com/community-q-a-7/single-event-8055)) | Pricey for occasional use; rooms can't be scheduled ([Software Advice](https://www.softwareadvice.com/event-management/slido-profile/reviews/)) |
| **Mentimeter** | Quiz Competition with top-10 leaderboard slides; up to 2,000 quiz players ([help](https://help.mentimeter.com/en/articles/410463-how-to-create-a-quiz-competition), [plans](https://help.mentimeter.com/en/articles/5938993-which-plan-is-right-for-you)) | Custom themes on Pro | Free (50 participants/month); Basic $11.99, Pro $24.99 per presenter/month, billed yearly ([plans](https://www.mentimeter.com/plans)) | Conference package for one-off events |
| **Kahoot!** | Timed quiz, points, podium, team mode | Custom themes only on top plans | 360 Pro $49/host/month billed yearly, 2,000 players ([Kahoot](https://kahoot.com/employee-training-360standard/)) | **Terms bar use at conferences/marketing unless authorized** on most plans ([plan matrix, Apr 2026](https://support.kahoot.com/hc/article_attachments/35538125352093)); "feels like a kids game" ([TrustRadius](https://www.trustradius.com/compare-products/kahoot-vs-slido)) |
| **Crowdpurr** | Live trivia, bingo, polls, social walls; AI trivia generator | Branding on paid plans | Free (20 people); $49.99 to $999.99 per month, 30-day minimum, 50% off yearly ([pricing](https://www.crowdpurr.com/pricing), [FAQ](https://help.crowdpurr.com/en/articles/10524844-crowdpurr-frequently-asked-questions)) | Built for the big screen |
| **Wooclap** | "Competition mode" with rankings and timed scoring; group answers ([pricing](https://www.wooclap.com/en/pricing/pricing-business/)) | Paid tiers | Free Starter (5 questions/month); paid annual | Education roots |

**Takeaway:** these tools own the in-session moment and the projector. Questify should **integrate or
import** results rather than rebuild Slido. Its own live voting and quiz quest types should award
event-wide points, which none of these do.

---

## (d) Saudi and MENA landscape

| Player | What it is | Gamification / loyalty | Relevance | Source |
|---|---|---|---|---|
| **Webook.com** | Official Riyadh Season ticketing; streaming; WBK cashless card | Subscription tiers (Free, Riyadh Season 10 SAR/mo, Gold 200 SAR/mo, Black, Diamond) with early booking and resale limits; Saudi Rewards points earn/burn; live song voting in concerts; WBK Digital Card for rides and skill games (Jan 2026) | Owns the Saudi consumer event wallet. **Partner, not rival** | [plans](https://webook.com/blog/guide-to-webook-app-subscription-plans/), [Saudi Rewards](https://www.linkedin.com/posts/webookcom_saudirewards-webook-lifestylerewards-activity-7303145668909395968-7iEH), [Asharq Al-Awsat](https://english.aawsat.com/business/5055768-webook-boost-saudi-entertainment-sector-profits), [Leaders MENA](https://www.leaders-mena.com/webook-com-launches-wbk-digital-card-at-riyadh-season-jeddah-wonderland/) |
| **Platinumlist** | MENA ticketing; 300+ organizers in KSA | **Plus** membership launched Jul 2026 ($7.90/mo): early access, member pricing. Offers organizers loyalty points and cashback | Ticketing loyalty, no in-event quests | [Zawya](https://www.zawya.com/en/press-release/companies-news/platinumlist-introduces-plus-membership-for-saudi-arabias-most-active-users-399798), [partners](https://platinumlist.net/for-organisers/partners/) |
| **MDLBEAST / NOFOMO app** | Soundstorm festival tickets; RFID wristbands; wallet credit | None found beyond wallet credit and ticket tiers | Festival ops benchmark | [FAQ](https://mdlbeast.com/events/soundstorm-25/soundstorm-2025-faqs), [T&C](https://mdlbeast.com/terms-and-conditions) |
| **Riyadh Season app** (GEA) | Guide, booking, zones | No quest layer in the store listing | Gap: the biggest audience has no attendee game | [Google Play](https://play.google.com/store/apps/details?hl=en_US&id=sa.gea.riyadhseason.main) |
| **Riyadh Season Treasure Hunt** (UNIT9, 2023) | One-off Unity app; 40 puzzles, AR, QR; $1.6M prize; 100k+ downloads | Staggered releases to stop cheating; live finale | Proves Saudi appetite for big-prize quests | [UNIT9](https://www.unit9.com/project/riyadh-season-treasure-hunt/) |
| **Beast Land** (Riyadh Season 2025, The Flash Pack) | Custom RFID game platform: 82,072 players, 285,475 plays, ~906M points in 45 days | Every interaction tied to a verified identity; auditable | Agencies build bespoke; Questify could be the reusable version | [Flash Pack](https://itstheflashpack.com/case-studies/powering-beast-land-with-a-large-scale-gamified-digital-experience/) |
| **Eventfiy** (Riyadh) | Gamified event platform startup | QR challenges, leaderboards, maps; $499/event Starter, $999 Pro; white-label only on Enterprise | **Closest direct Saudi competitor** found | [eventfiy.app](https://eventfiy.app/) |
| **Zero One DEG** (Riyadh) | Gamification engine for telecom, banks, retail | Challenges, points, tiers, rewards journeys, anti-abuse rules | Enterprise loyalty, not events | [zeroone.com.sa](https://zeroone.com.sa/products/deg) |
| **Gameball** (Egypt/MENA) | Gamified loyalty SaaS; 3,000+ brands; Salla app | Points, tiers, challenges, streaks; in-country hosting | Benchmark for points-economy rules (pending points, expiry) | [gameball.co](https://www.gameball.co/), [loyalty](https://www.gameball.co/loyalty) |
| **Resal** (KSA) | Digital gift cards, 1,000+ brands; Resal Connect points exchange | API and webhooks; SAR settlement; local hosting, PDPL, ISO 27001 | **Fulfillment partner** for a rewards store | [enterprises](https://www.resal.me/en/enterprises/), [Connect](https://www.resal.me/en/resal-connect/) |
| **Sajilni**, **Aone Connect**, **Rizi**, **Hdour**, **EventHub** | Arabic/English event apps, registration, QR check-in | Polls, Q&A, networking; no meaningful quest/points layer found | Integration targets or channel partners | [Sajilni](https://sajilni.sa/sajilni-products/event-mobile-app/), [Aone](https://aone.sa/products/aone-connect-mobile-app), [Rizi](https://www.rizi.app/), [Hdour](https://linkedin.com/company/hdoursa), [EventHub](https://eventhub.tech/) |
| **Agencies** (ECHT, Fuel Media) | Custom QR hunts (Novo Nordisk KSA, 450 staff, 5 weekly missions); SAFF "Falcon's Nest" fan app | Bespoke builds per client | Shows corporate and sports demand; Questify replaces one-off builds | [ECHT](https://echt.me/projects/qr-treasure-hunt-team-building-activity-rebel-mission), [Fuel](https://fuelmedia.com/saff-fan-app) |

---

## (e) Consumer gamification benchmarks (not competitors)

| Product | Lesson for Questify | Source |
|---|---|---|
| **Duolingo** | Streaks (7-day streak users 3.6× likelier to finish a course), streak freezes, weekly leagues that tripled highly engaged learners, Rive-driven characters | [streak research](https://blog.duolingo.com/how-duolingo-streak-builds-habit/), [Lenny's](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth) |
| **Pokémon GO** | Location play at scale; published three-strike anti-spoofing policy | [Niantic policy](https://niantic.helpshift.com/hc/en/6-pokemon-go/faq/39-gameplay-fairness-policy-1701994322/) |
| **Strava** | Segment leaderboards need ML auto-flagging; 6.5M impossible efforts removed in one cleanup | [Strava community](https://communityhub.strava.com/what-s-new-10/keeping-leaderboards-fair-more-leaderboard-improvements-8009) |
| **Starbucks Rewards** | Mar 2026 relaunch: Green/Gold/Reserve tiers, a low 60-Star tier for early redemption, dollar caps per tier, stars that expire unless you act | [Starbucks press](https://about.starbucks.com/press/2026/starbucks-unveils-reimagined-loyalty-program-to-deliver-more-meaningful-value-personalization-and-engagement-to-members/) |
| **Swarm** | Check-in coins, mayorships (most check-ins in 30 days, one per day counts), check-ins too close together don't count | [Foursquare support](https://support.foursquare.com/hc/en-us/articles/21163361393948-Fun-with-Swarm-Coins-Mayorship-Collectibles-and-Stickers) |

Full mechanics analysis is in `GAMIFICATION_PATTERNS.md`.

---

## Comparison table

✓ = native, ◐ = partial or via add-on/integration, ✗ = none found, ? = not verified.

| Product | Physical quests (QR/GPS/photo) | Anti-cheat strength | Points rewards store | Rename currency | White-label app | Arabic UI | Entry price |
|---|---|---|---|---|---|---|---|
| Whova | ◐ stamps | Low | ✗ (top-N prizes) | ? | ◐ | ◐ (labels English) | ~$2.3k/500 att. |
| Cvent Attendee Hub | ✓ QR | Medium | ✗ | ? | ✓ | ✗ | Quote, high |
| Swapcard | ◐ via Captello | Medium | ◐ gift cards via Captello | ? | ◐ add-on | ✓ | $610/yr + volume |
| Bizzabo + Klik | ✓ hardware | **High** | ✗ | ? | ✓ | ? | Quote, high |
| EventMobi | ◐ passcodes | Low | ◐ manual | ? | ✓ | ? | $3k/event |
| Brella / Grip | ◐ via third parties | ? | ✗ | ? | ✓ | ? | Quote |
| Airmeet | ✗ virtual | Low | ✗ | ✓ | ? | ? | ? |
| InEvent | ✓ QR, missions | Medium (moderation) | ◐ manual swag | ✓ | ✓ | ? | Quote |
| vFairs | ✓ QR hunt | Low | ◐ redeem-QR | ? | ✓ | ? | Quote |
| Goosechase | ✓ photo/GPS/text | Low | ✗ | ✗ | ✗ | ✗ | $99–$749/event |
| Scavify | ✓ | Medium | ◐ completion reward | ? | ◐ logos | ? | Quote |
| Loquiz / Actionbound | ✓ GPS/QR | Medium | ✗ | ? | ✓ | ✓ custom languages | €9/player; €350/50 |
| Eventfiy (KSA) | ✓ QR | ? | ? | ? | Enterprise only | ? | $499/event |
| Captello | ✓ games, waypoints | Medium | ✓ gift cards | ? | ✓ branded games | ? | Quote |
| **Questify (target)** | ✓ all types | High (layered) | **✓ store, stock, staff redeem** | ✓ | ✓ | **✓ RTL-first** | Mid-market |

---

## Table stakes (every serious competitor has these)

1. A live leaderboard in the app **and** on a projector screen (EventMobi, Crowdpurr, Scavify, InEvent).
2. Organizer-set points per action, with caps or min/max repeats (Cvent, Airmeet).
3. QR or code check-ins for booths and sessions, plus printable code export.
4. Photo/video submission challenges with an admin review queue (Eventzee, Goosechase, InEvent).
5. Timed release and hide/show of challenges (EventMobi, Goosechase, Webex).
6. Sponsor tie-ins: higher-value sponsor quests, sponsor logos on prizes (Airmeet, EventMobi).
7. Push notifications and announcements to drive play.
8. Post-event export: rank, name, points, email (Airmeet, InEvent).
9. Branding: logo and colors at minimum; white-label app at the top tier.
10. Polls, quizzes and Q&A, natively or by integration (Slido, Kahoot, Mentimeter).

## Gaps Questify can own

1. **A real points economy with a rewards store.** Nearly everyone stops at "top 10 win a prize".
   EventMobi's sold-out swag shop and vFairs' redeem-QR show the demand, but redemption is manual.
   Questify can ship stock levels, per-user limits, staff scan-to-redeem, and digital gift cards
   through a Saudi supplier like [Resal](https://www.resal.me/en/enterprises/). Everyone can
   spend, not just the top 10.
2. **Arabic-first, native RTL.** Goosechase is English-only, Cvent lists no Arabic, and Whova
   cannot translate its own labels (sources above). Only Swapcard and local tools treat Arabic as
   first-class, and none of them is quest-first.
3. **Premium, consumer-grade feel.** Reviews of Whova, Bizzabo and Cvent keep saying cluttered,
   overwhelming, hard to navigate. No event app plays like Duolingo. 3D icons, motion and visible
   progress are open ground.
4. **Verification without hardware.** Klik is strong but needs badges; code-based games leak
   codes; Goosechase accepts any photo. A software stack (rotating QR, hidden staff code, geofence
   as a soft signal, moderation queue, device integrity) gets close to hardware-grade trust.
5. **Overlay, not replacement.** The Satoshi Quest result (72% activation inside an existing
   Brella app) and Captello's business show organizers will add a game layer to the app they have.
   Questify should join from a ticket QR or link (Webook/Platinumlist buyers) and not demand a
   platform switch.
6. **Mid-market self-serve pricing.** Goosechase tops out at $749/175 players. EventMobi starts
   at $3,000 and Whova around $2,299. Eventfiy prices $499–$999 per event but gates white-label.
   Self-serve per-event tiers with white-label as a paid toggle fit the space between them.
7. **Sponsor monetization built in.** Sell sponsored quests, branded checkpoints, leaderboard
   naming, and a sponsor ROI report (visits, dwell, points earned per sponsor). Organizers already
   sell these by hand.
8. **Seasons across events.** Scavify is "event-only". Corporate clients (Novo Nordisk KSA ran 5
   weekly missions) and Riyadh Season-style venues need a persistent profile, levels and history
   across many events, with each event as an episode.
9. **Saudi compliance by design.** Prize **draws** need a Chamber of Commerce license, cannot
   require purchase, and must exclude the organizer's staff and relatives. Results within 30 days,
   prizes within 7 days ([Ministry of Commerce](https://mc.gov.sa/en/mediacenter/News/Pages/21-09-25-01.aspx),
   [Asharqia Chamber](https://www.chamber.org.sa/en/subscribers/business-service/)). Lottery-style
   prizes are banned ([MC](https://mc.gov.sa/ar/mediacenter/News/Pages/20-03-24-01.aspx)). A
   skill-based store, staff-exclusion lists and a draw-license checklist set Questify apart. Get
   legal counsel on whether a points store counts as a "commercial competition".
10. **PDPL data residency.** Saudi PDPL limits transfers abroad and requires documented, purpose-specific
    consent ([SDAIA regulation](https://sdaia.gov.sa/en/SDAIA/about/Documents/ImplementingRegulation.pdf)).
    In-Kingdom hosting is a selling point for government and corporate buyers (Resal and Gameball
    already market it).
