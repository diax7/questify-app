# App Store Connect: age rating questionnaire

Prepared 2026-11-13. Where: App Store Connect, the app, App Information, Age Rating. The rating tiers and the minimum
age each descriptor causes were read on 2026-11-13 at
`developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/` **[form]**;
the page lists the descriptors and tiers but not the exact question wording, so the question texts below are
paraphrased and must be matched to the live form. The result is the highest minimum age any answer causes.

**Expected result: 13+** (caused by "Contests: Frequent"). That equals the product's minimum age (ADR-028: nobody under
13 signs up) and the declared Play audience (`play-content-rating.md`). A higher rating would only come from a "Yes"
below that the code does not support.

## Answers

| Descriptor (live form wording may differ) | Answer | Min age it would cause | Trace to code and docs |
|---|---|---|---|
| **In-App Controls: parental controls** | No | 4+ either way | None built. The app has no parental setting |
| **In-App Controls: age assurance** | No | 4+ either way | Birth year is self-declared at sign-up, and under 13 is refused (ADR-028). That is an age gate, not verification, so do not claim assurance. No Declared Age Range API (EXPO_SDK_CHECK: no age-range library). Revisit if a region makes the API mandatory (Apple age-assurance page) |
| **Capabilities: unrestricted web access** | No | 16+ if Yes | No browser and no WebView in the app (`package.json`: no `react-native-webview`). Links the organizer adds (Home links, event info rows, a venue map) open the phone's own browser through `Linking.openURL` (`HomeBlocks.tsx`, `InfoSections.tsx`, `info.tsx`); that is not an in-app browser |
| **Capabilities: user-generated content** | **Yes** | 4+ | Usernames, text and photo submissions, join answers, help requests, and the organizer-approved **photo wall** (T-504b, ADR-830): pre-moderated or team-picked, Report and Block on every photo, community guidelines accepted before the first submission (FR-1706), organizer and Questify queues (STORE_COMPLIANCE 1.2, 2.8) |
| **Capabilities: messaging and chat** | No | 4+ | No player-to-player message exists. Help requests go to the event team (private); "cheers" are five fixed reactions on the big screen with no text (T-509); a meet quest exchanges a one-minute QR code, not a message |
| **Capabilities: social media** | No | 13+ if Yes | The definition is redistributing, amplifying or interacting with UGC through a social feed or similar discovery method (STORE_COMPLIANCE 1.14). The photo wall is a gallery of photos the owner allowed and the team picked (at most 20 per event), with no feed ranking, no likes, comments, re-sharing or following. Report and Block are safety controls. **Re-check when any of those appear** (G9). Answering Yes would not change the result, still 13+ |
| **Capabilities: advertising** | No | 4+ | No ad network or SDK. An organizer's sponsor strip and "Presented by" labels are organizer-managed names and logos with no link-out or targeting (ADR-067). The same question on Play is answered differently, see G5 |
| **Mature themes: profanity or crude humor** | None | | Content is organizer-written and fit for 13+ (organizer content rules); usernames and text pass Arabic and English word lists (ADR-068) |
| **Mature themes: horror or fear** | None | | |
| **Mature themes: alcohol, tobacco, drugs** | None | | Organizer rules forbid it for a 13+ audience; Questify does not host such content |
| **Medical or wellness: health or wellness topics** | None | | A challenge that risks physical harm is refused by policy (Apple 1.4.5; PD-29). A fitness-themed quest is the organizer's, but the app has no health content |
| **Medical or wellness: medical or treatment information** | None | | |
| **Sexuality or nudity: mature or suggestive themes** | None | | Voting never rates a person's looks (PD-13) |
| **Sexuality or nudity: sexual content or nudity; graphic** | None | | Nudity in a submitted photo is removed by moderation (community guidelines) |
| **Violence: cartoon or fantasy** | None | | The mascot and quest art are adventure-game style without combat. Mini-games are memory match and slide puzzle (T-305) |
| **Violence: realistic; guns or weapons; prolonged graphic** | None | | |
| **Chance-based: contests** | **Frequent** | **13+** | The core loop is competing for points and rank, and rank prizes at an event are contests (STORE_COMPLIANCE 1.12 and 1.14: frequent contests are 13+). Rewards are a fixed-price points store plus rank prizes (ADR-008) |
| **Chance-based: simulated gambling** | None | | No casino-style game, no wagering of points; points are never spent on chance entries (PD-05) |
| **Chance-based: gambling (real money)** | None | | No raffles in v1 (PD-06), no money in or out |
| **Chance-based: loot boxes** | None | | Levels and gem-shop items come from fixed levels or tiers; nothing is random or sold (ADR-760, PD-31, PD-32) |
| **Region-specific questions (for example Australia, Brazil)** | Answer from the same facts | | Social media would be 16+ in Australia if answered Yes. It is No (see above) |

If the form includes a minimum-age override ("a higher rating can be set to match a minimum-age policy"), **leave it
unset**: 13+ is already the result.

## Things the reviewer or a regulator may question

- **Photos of other players on the wall** and the Social media answer. The recorded decision is "No"; the evidence is in
  the review notes (the wall is opt-in per photo, off by default, team-picked, with Report and Block). Q-766 (minors
  aged 13 to 17 on the wall) is still open with counsel.
- **Prizes of real value.** Apple lists contests as an age descriptor, not a reason to refuse; the guideline 5.3
  obligations are met by the official rules shown in the app on the event's info screen (`rules.notSponsors`: "Apple and
  Google are not sponsors of this contest and are not involved in it in any way").
- **The Arabic and English app are both rated the same.**

## Update this form when

Social features are added (feed, likes, comments, chat); raffles or any chance-based reward (18+ and a Chamber licence,
PD-06); an in-app browser or WebView; an ad network (PD-27). The turn-on of a capability that changes rating is a
blocking step for platform admins (PD-28).
