# Open Questions — Questify

Honest unknowns. Each has why it matters and the stage that resolves it. When one is answered,
move the answer into the right doc (often `DECISIONS.md`) and delete the question here. Question
IDs are never reused.

**Legal questions are batched.** Everything marked "counsel" goes to one Saudi lawyer review near
the end of planning (user, 2026-10-16).

**Answered so far:** Q-030 → ADR-101, Q-002 → ADR-006, Q-008 → ADR-008, Q-019 → ADR-015, Q-020 → ADR-010,
Q-048 → ADR-014, Q-065 → ADR-016, Q-066 → ADR-019, Q-067 → ADR-017, Q-068 → ADR-018, Q-001 → ADR-022, Q-007 → ADR-023,
Q-003 → ADR-024, Q-005 → ADR-025, Q-052 → ADR-026, Q-012 → ADR-027, Q-014 → ADR-028, Q-013 → ADR-029,
Q-004 → ADR-030, Q-011 → ADR-032, Q-054 → ADR-034, Q-055 → ADR-035, Q-006 → ADR-040, Q-009 → ADR-040/041. Q-016 → ADR-048, Q-072 → ADR-047, Q-073 → ADR-047. Q-010 → ADR-049, Q-018 → ADR-050. Q-017 → ADR-052, Q-058 → ADR-053, Q-015 → ADR-054. Q-057 → ADR-055. Q-059 → ADR-061. Q-056 → ADR-066 (dropped). Q-032 → ADR-070, Q-045 → ADR-071. Q-050 → moot (ADR-073: declarations always cover every feature). Q-023 → F-45, Q-064 → ADR-062/082., Q-079 → ADR-110, Q-046 → `compliance/EXPO_SDK_CHECK.md`. 2026-10-21: Q-094 → ADR-124, Q-098 → ADR-125, Q-053 → ADR-126, Q-082 → ADR-127, Q-089 → ADR-128, Q-103 → ADR-129, Q-069 → ADR-130, Q-021 → ADR-131, Q-096/Q-097/Q-099/Q-101/Q-102 → ADR-132, Q-087 → ADR-072 confirmed, Q-100 → FR-620/FR-830 amended

## Product

| ID | Question | Why it matters | Claude's leaning | Stage |
|---|---|---|---|---|

## Business & launch

| ID | Question | Why it matters | Stage |
|---|---|---|---|
| Q-022 | Is there a first pilot event, and a target date? **2026-10-21: not yet (with Q-077).** | Sets the roadmap and the first-release cut | 3 / 8 |

## Compliance & legal

These came from `STORE_COMPLIANCE.md` (its SC-## IDs are shown). Compliance questions that
overlap the ones above were merged into them.

| ID | Question | Why it matters | Who answers | Stage |
|---|---|---|---|---|
| Q-040 (SC-02) | Organizers fund the prizes, but Apple 5.3.1 says the developer must sponsor contests. Is naming Questify as administrator, with the organizer as prize provider, enough? | It could cause a rejection; Apple's documentation doesn't say | Apple (ask in the first submission's notes) + counsel | 8 |
| Q-041 (SC-03) | Does an organizer's leaderboard with prizes at a commercial event count as a Ministry of Commerce "commercial competition" that needs a Chamber licence? And at internal corporate events? | Decides whether organizers can set up rank prizes themselves | Counsel | 3 |
| Q-042 (SC-04) | What age counts as full legal capacity for PDPL consent? Can attending an event be the legal basis for 13–17-year-olds instead of guardian consent? | Shapes sign-up and the minimum age | Counsel | 1 Interim (ADR-084): 13–17s use the app like adults, including marketing if they opt in; counsel to confirm. |
| Q-043 (SC-05) | Is Questify a controller, joint controller or processor of attendee data at an organizer's event? | Decides who answers data requests, who reports breaches, and the organizer agreement | Counsel + Dhia | 3 Wallet passes (ADR-091) store a username and numbers in Apple and Google accounts outside the Kingdom; **user states the lawyer accepts it (2026-10-17); to be confirmed in the lawyer review.** |
| Q-044 (SC-06) | Are registration on SDAIA's National Register and a data protection officer mandatory for Questify? | A legal obligation, or voluntary | SDAIA self-assessment + counsel | 8 |
| Q-046 (SC-10) | Do the chosen framework and SDKs ship privacy manifests and support Android target API 36 and Xcode 26? **Answered 2026-10-19 (T-015, research):** Apple has required Xcode 26 / iOS 26 SDK since 28 April 2026; Google Play has required target API 36 for new apps and updates since 31 August 2026 (extension to 1 November 2026). Expo SDK 57 (30 June 2026) is current; SDK 56 needs Xcode 26.4, supports Android 7+ and iOS 16.4+, and has a Hermes memory regression fixed in SDK 57. **Use SDK 57 at build start.** Consequence: iOS minimum becomes 16.4 (Q-082). **Checked 2026-10-20 (T-015): SDK 57 meets both stores today; the dated check and its actions are in `docs/compliance/EXPO_SDK_CHECK.md`.** | Either one blocks the upload | Stage 6 check | 6 |
| Q-047 (SC-11) | Has Saudi Arabia's draft Consumer Protection Law (Arabic-only information duties) been enacted? | Arabic duties and the competition rules it references | Counsel | 8 |
| Q-049 (SC-14) | Which Play Console declarations (EU trader status, app content) apply to this account? | Not verifiable before the account exists | Check at account setup | 8 |
| Q-051 (SC-17) | How long must prize-fulfilment and moderation records be kept after an account is deleted? | Retention wording in the privacy policy and the deletion page | Counsel | 8 |
| Q-088 | Organizer legal text v0 (FR-1726, `legal/organizer-*.md`): (a) refund and cancellation terms for a paid event; (b) the notice Questify gives before ending an organizer's terms; (c) how long event data stays after an organizer account ends, and whether the organizer gets a final export; (d) the breach-notice window to organizers and the sub-processor change notice; (e) audit rights; (f) whether to keep the indemnity and suspension for an unpaid invoice. No requirement yet describes what organizer account deletion (ADR-077) does to events, players' event data and open prize reservations | The drafts leave these as placeholders; T-101 records acceptance of these versions | Counsel (T-807) + user | 8 |
| Q-085 | Player legal text v0 (T-119, `legal/`): (a) the legal basis to name for each processing purpose (contract, consent, legal duty, legitimate interest); (b) the response time we promise for data-subject requests; (c) the wording and reach of the liability limit; (d) the dispute forum (courts of a named city, or arbitration). | The drafts leave these as placeholders or generic text; PDPL Art. 12–13 and SDAIA's guideline expect the legal basis and response times stated | Counsel (T-807) | 8 |

## Technical

| ID | Question | Why it matters | Stage |
|---|---|---|---|
| Q-031 | Backend: which managed PostgreSQL in a live Saudi region (Google Cloud Dammam via CNTXT, Oracle Riyadh/Jeddah, or another), and which open-source libraries for sign-in, real-time and storage? Managed Supabase is ruled out (no Middle East region, ADR-086) **Stage 6 (2026-10-17): user decided "I will see later".** Claude's lean: Oracle Riyadh (main) + Jeddah (recovery); Google Dammam via CNTXT is the fallback; AWS Saudi is announced for December 2026 and Azure for Q4 2026, neither confirmed live. Still to verify: that managed PostgreSQL and a Redis-compatible cache are offered in Riyadh/Jeddah, and a real quote (`INTEGRATIONS.md`) **Checked 2026-10-19 (T-014, research only):** Oracle lists Riyadh (me-riyadh-1) and Jeddah (me-jeddah-1) as live, one availability domain each. Oracle says Email Delivery is in every commercial region; OCI Cache (Valkey 7.2/8.1, Redis 7.0.5) and OCI Database with PostgreSQL are regional services, but Oracle's public pages do not list them per region for Riyadh/Jeddah. **Still needed: open the OCI console on a real account, pick Riyadh, and confirm 'Create PostgreSQL DB system' and 'Create cache cluster' are offered.** **Decided for now 2026-10-19: CranL Pro, riyadh-1 (ADR-107). Open: CranL's written answers on HA, point-in-time restore, backup copies, uptime and hosting provider; production move to Oracle/sccc/Google if they fall short.** | Hard to reverse; tenant isolation, residency (ADR-070), recovery targets (ADR-082) | 6 |
| Q-033 | How far can "change without a release" go: config and content only, or also over-the-air code updates? | Apple 2.5.2 limits downloading code (ADR-007) | 6 |
| Q-034 | SMS and email providers? Price per login SMS in Saudi Arabia, and what a 20,000-player event costs (Questify absorbs it, ADR-099) **Stage 6:** SMS shortlist is Msegat or Taqnyat (ADR-103); get written quotes and register a sender name (SAR 230 a year, commercial registration + Chamber letter). Email provider still open: prefer the cloud's in-region email service **Checked 2026-10-19:** Msegat needs a valid Saudi commercial registration (individuals cannot subscribe), takes 3–7 business days to open the account and 3–7 more to activate a sender name through the Jaber system (SAR 230 a year, English-only sender names, Chamber of Commerce authorization letter). One point per SMS; Arabic text splits at 70 characters per segment, so keep OTP texts short. Unified price on all Saudi networks. A SAR 699 one-year package exists but its message count was not shown. The API can require a static server IP (can be switched off). Taqnyat figures are in INTEGRATIONS.md. **Update 2026-10-19: Msegat is in use (active account, services and ads senders, user's statement). Integration notes are in INTEGRATIONS.md. Still needed: Msegat's quote at volume and delivery-receipt details.** **Interim email path (ADR-117, T-107):** player sign-in codes by email go through the staff Gmail mailbox (Resend as backup) with their own budget of 1,000 a day; a Workspace mailbox's daily sending cap makes this a limit for large events that lean on email, so the player email provider is still to be chosen here. | Saudi sender-ID registration; the SMS bill is unbounded by event size | 6 |
| Q-070 | Deferred deep link on iOS (F-71): is "the event page copies the code, the app offers a one-tap paste button" reliable and allowed, with no fingerprinting or tracking SDK (PD-27)? Android uses the Play install referrer **Stage 6 proposal:** the event page copies the link on tap; after install a "Paste event code" button reads it; Android uses the install referrer. No fingerprinting: shared venue Wi-Fi makes it unreliable. Confirm in the grill | Decides whether "scan → install → land in the event" works on iPhone or needs a second scan | 6 |
| Q-071 | NFC (F-105): which tag type; iOS and Android read/write limits; how the app proves a tap came from a real tag rather than a shared link; share of Saudi Android phones without NFC **Stage 6 note:** static NFC tags can be copied, so a tap is a weaker proof than a scan. **Answered 2026-10-24 (T-308 plan, ADR-234, ADR-237; Dhia: basic tags only, Q-198):** `react-native-nfc-manager` v4.1.0 reads and writes NDEF on both phones. iOS: in-app reading always shows the system sheet; background reading only for universal links (iPhone XS+). No Saudi figure for phones without NFC; budget Android lines still lack it. Basic tags (NTAG213/215): a signed URL, a tap whose sticker id differs is paid and flagged; the QR always stays on. Sources in the plan | Decides whether NFC quests work on every phone and how far they can be trusted | 6 |
| Q-074 | Tuning values and their defaults: My QR grace period; the rotation interval of screen QR codes (30–60 s); thresholds for the flags ("far from the venue", impossible speed, bursts); "running low" for stock and uploaded codes; how long pickups stay reserved by default | The SRS states the behaviors; the numbers need real-world testing. Organizers adjust some per event | 6 |
| Q-075 | Retention periods per data type: location readings, photos, help tickets, logs, closed-event data, inactive accounts, organizer exports, the deletion fingerprint (FR-1704). Closed-event data never includes the permanent record FR-751 keeps: score, `final_rank`, `souvenir_receipt`, `player_item`, XP and achievements stay (ADR-337, T-410) | The privacy policy must state a period per type (`STORE_COMPLIANCE.md` §4); PDPL minimization | 8 (counsel, with Q-051) |
| Q-076 | Wallet passes: does Apple allow an organizer's logo and name on a Questify-signed pass, and does a Pass Type ID on the personal developer account (ADR-010) work for this? Do both wallets accept the Questify frame design? **Stage 6:** the signing certificate can be made without a Mac (OpenSSL on Windows plus the Apple developer web portal). Whether the personal account works for a Pass Type ID is not checked | The pass design depends on it | 6 / 8. **User states yes, Apple allows an event logo on a wallet pass (2026-10-17); not independently checked.** |
| Q-077 | When is the first event, and what is cut if the build runs long? The user chose no review point and no cut order (Stage 5, 2026-10-17). **2026-10-21: no pilot event yet; keep building in task order (user).** | v1 holds about 510 requirements for a team of one developer plus Claude; without a date or a cut order the first event can slip indefinitely | 8 |
| Q-078 | The stores list the individual (Dhia) as seller (ADR-010), but a company signs the organizer contracts and invoices (ADR-076). Which party is named as the controller of player data in the privacy policy and terms, and who is responsible to organizers and players? | Decides the wording of the privacy policy, terms and organizer DPA (with Q-043) | 8, counsel |
| Q-080 | Name display (ADR-106): may other players see a player's full name when the owner chooses it? What must the join card say, and does PDPL data minimization allow it? Applies to the event ranking, big screen and profile cards | Relaxes the rule that only username and avatar are public (FR-120, ADR-032); privacy-law question | 8 (counsel) |
| Q-081 | Tickets (ADR-105): is 'one reply, then closed' enough for event teams and players, or do we allow one follow-up? Which response-time targets apply to the Questify queue? | Players cannot follow up in the same ticket | 8 |
| Q-084 | Audit log retention and anonymisation (T-004): how long are audit entries kept, and how does a player's deletion anonymise entries that name them, when the table refuses every change? Today no entry names a player (actors are staff, admins and the system), so nothing waits on it yet | The privacy policy needs a period (Q-075); the first player-facing entry (T-1xx) needs the anonymisation path designed first | 8 (counsel, with Q-075) |
| Q-083 | (2026-10-21: the user keeps Gmail alone while its mail does not land in spam; the Resend backup and its domain are skipped for now, and would use the same domain as Gmail.) (2026-10-20: the user chose the Gmail API from `questify@nafes.com` (nafes.com Google Workspace), ADR-112; still open for counsel: Google is a foreign provider.) Final email provider for staff sign-in codes and invites: keep Gmail (dedicated account) with Resend as backup, or a provider in Saudi Arabia? Gmail has a daily send cap and puts the codes through a foreign provider | Staff codes and the data map (NFR-020); the stop-gap is in `INTEGRATIONS.md`. Needs a domain for the Resend backup and counsel's view (T-807) | 8 |
| Q-107 | Booths (FR-909): the owner limits an operator to chosen quests today (T-204). Should a booth exist as its own thing (a named place grouping quests, with its own station screen), and when? Claude's recommendation: wait until an organizer asks; quests cover a station today | A booth model changes the operator limit and the station picker; nothing waits on it now | 9 |
| Q-110 | Organizer suspension (FR-1607, and the suspend half of FR-1402) moved from T-210 to T-701 (console foundation, which also lists FR-1402). It narrows every player read path (event page, list, quests, home) and `join_event`, which T-212 rewrites at the same time. Claude's recommendation: accept the move; T-701 uses `organizer.status = 'paused'` and the enrollment trigger pattern of ADR-141 | Until T-701, a misbehaving organizer is stopped by hand (support) | 8 |
| Q-111 | Usage figures (FR-1730) and editable support contact (FR-1731) moved from T-210 to T-703 (platform settings): no SMS, push or storage metering exists yet, and the contact page waits on T-706. The emails to the owner on activation, rejection and the 80%/100% marks wait for the alert switches (FR-1727); the dashboard card and banner are the alert now. Claude's recommendation: accept both moves | The owner learns of an activation on the dashboard, not by email, until the alerts task | 8 |
| Q-115 | Retention of join answers and guest lists (T-212, Q-075): a guest list holds contacts of people who may never sign up. Should it be purged a set time after the event ends, and are a player's answers erased when they delete their account (T-217) or only with the event's data? Built: both stay with the event; answers go when the enrollment goes. Claude's recommendation: purge guest lists 30 days after the end, erase answers with the account | PDPL minimization; the deletion flow (T-217) and the retention job need the rule | 8 (counsel) |
| Q-116 | Console reads are not audited yet (T-210 CTO review): `GET /v1/admin/activation-requests`, `/v1/admin/events?code=` and `/v1/admin/events/{id}` show an owner's email and write no audit row, while SECURITY threat 5 promises every admin read is logged. Claude's recommendation: T-701 (console foundation) adds one audit row per console read, with the rest of the console | Until then a misused admin account's reads leave no trail | 7 |
| Q-117 | Times and kind after activation (T-210 CTO review): an organizer can still change an activated event's start, end and kind (0009's column grants), so ADR-142's checks (times ahead, a venue for a physical event) and any paid window (ADR-076) can be undone after activation. Claude's recommendation: lock the end to at most the activated window and keep a physical event's venue required, in T-701 or when pricing by duration is decided | An event could run longer than what was activated | 7 |
| Q-106 | Spending after the event (ADR-135): with "spending lowers rank" on, should purchases in the days the shop stays open after the end also lower the score? Built: no, the final score is frozen at the end so rank prizes never move. Claude's recommendation: keep it so | If yes, results would change after the event and T-214 would need a frozen results snapshot | 8 |
| Q-105 | Renamed words beyond T-117 (FR-404, FR-405, FR-940): (1) the star is one of the five currency icons, and it is also the usual XP symbol (ASSET_INDEX); an event that picks the star could confuse points with XP once XP shows (T-4xx). (2) ADR-058 also names renaming "quest" and "category" (answered: FR-942, built in T-311b). Claude's recommendation: keep the star until XP has its own symbol on screen, then decide; write a requirement for quest and category renames only if an organizer asks | The star choice may need a change when XP ships; quest and category stay fixed words | 8 (brand) |
| Q-095 | Player legal steps (T-110): (1) when a new terms or privacy version is published, the app asks on launch but player routes keep working until the player accepts; should every route refuse until then (T-707's forced re-acceptance)? (2) A 13–17-year-old accepts the terms before the birth year is asked (the code screen comes first); does counsel need a guardian step or a different order (Q-042)? (3) Acceptance records are erased with the account (T-217) unless counsel wants them kept as proof (Q-051, Q-075). Claude's recommendation: keep launch-time asking, ask counsel (2) and (3) in the T-807 batch | Proof of consent and minors' consent against friction at sign-up | 7 |
| Q-093 | Login SMS ceilings (T-107): the whole platform may send at most 5,000 sign-in SMS an hour (a warning in the log at half), and each number 5 an hour and 10 a day. The platform ceiling is a brake on SMS pumping (ADR-099: Questify pays every SMS); a 20,000-player event whose crowd all signs in within an hour would hit it, and players beyond it are offered email. Claude's recommendation: keep 5,000 until the Msegat quote at volume is known, then set it from the largest booked event (about a quarter of its players an hour) | The SMS bill's worst case against a big event's opening rush | 6 |
| Q-092 | Account deletion and the points ledger (found in T-105): FR-126 and T-217 say deleting an account removes the player's points, but FR-317 and NFR-019 make the ledger append-only for every role. Claude's recommendation (same as Q-086): deletion anonymises the player row, the ledger rows stay (event totals and rankings stay right), the completion's `device_id` is cleared, and the profile and rankings stop showing the player | T-217's design and the privacy policy's wording | 8 (with Q-086 and counsel) |
| Q-091 | Do the shared time helpers (`packages/shared/src/time/event-time.ts`: `formatToParts` with a `timeZone`, the Gregorian calendar and Latin digits in Arabic) behave the same on Hermes in the player app as in Node? Check once on a development build (T-009) before T-113 shows event times | Event times on the phone; a wrong zone or Hijri date on Android would mislead players | 6 (with T-009) |
| Q-086 | Account deletion and points (found drafting T-119): FR-126 says deleting an account removes the player's points, but FR-1739 and NFR-019 keep the append-only points record with the player's identity removed. Which wins? Claude's recommendation: keep the ledger rows, anonymized (the ledger is append-only and event totals must stay correct), and say "your points are removed from your profile and rankings" in the policy | The privacy policy wording (`legal/privacy-policy.md` §deletion) and T-217's design | 8 (with counsel, T-807) |
| Q-090 | Team invites (T-101): an invited editor accepts no organizer documents (the terms and DPA bind the organizer, which the owner accepted). Is that enough, or must each editor accept the content rules personally? Also: the team list shows emails, not names (staff accounts have no name; UX §3.12 shows names). Add a name field to staff accounts? | Decides the invite screen and the team list | 8 (with counsel for the first part) |

## Q-118 — Editors' bulk awards and the cap (2026-10-23, T-207)
FR-1712 says bulk awards are "outside operator caps", written before ADR-152 capped editors. T-207 builds: the owner's
bulk is uncapped; an editor's bulk gives each player at most the per-award cap and does not count toward the daily
cap (otherwise a one-player list is an uncapped award). Dhia may lift the editor limit. Raised by the CTO plan review.

## Q-119 — Which flags ship first (2026-10-23, T-209)
T-209 builds same-device and burst flags (ADR-153). Far-from-venue and impossible-speed flags move to T-303b (ADR-196; no venue
pin, quest places or app location exist yet); device integrity moves to a new T-812 (needs Apple App Attest and Google
Play Integrity set up on Dhia's accounts). Dhia may want any of them sooner.

## Q-120 — Flag numbers and the held reservation's clock (2026-10-23, T-209)
Proposed: a burst is 10 or more scans within 5 minutes (Q-074); a same-device case is raised once per account and
phone, so a cleared "siblings share a phone" case stays cleared. A reservation held at the desk keeps its pickup
timeout (default 120 minutes): if the owner does not act in time, the points come back. Should the hold stop the clock?

## Q-121 — Find by name at the desk (2026-10-23, T-209)
ADR-156 lets the desk find a player by exact username or phone when My QR will not scan (new FR-1848). Dhia may prefer
scan-only at the desk.

## Q-122 — Rehearsal code or personal passes (2026-10-23, T-211)
ADR-158 uses one standing rehearsal code per event (as the Overview wireframe shows), at most 25 rehearsal accounts,
rotate and erase to clean up. A stricter option: each team member makes a single-use pass in the dashboard per phone.
Dhia may prefer the stricter one, or another cap than 25. The risk with the standing code: an unactivated Draft
could run a free 25-person event through rehearsal for as long as it likes (nothing is wiped until go-live, and a
Draft never goes live by itself).

## Q-123 — Digital rewards in rehearsal (2026-10-23, T-211)
ADR-159 shows a random test code in rehearsal, so no real code is spent. The team cannot check that real codes reveal
correctly until go-live. Acceptable?

## Q-124 — Erasing rehearsal points from the ledger (2026-10-23, T-211)
ADR-157 adds one exception to the append-only ledger: rehearsal entries are deleted at go-live (audited with counts),
and amends NFR-019 to say so. Dhia should confirm this reading of NFR-019 and ADR-080.

## Q-125 — Time windows in rehearsal (2026-10-23, T-211)
ADR-159 treats the event and its shop and desk as open in rehearsal, but keeps each quest's and reward's own
opening times. A reward that opens at 14:00 on the day cannot be tried earlier. Should rehearsal ignore those too?

## Q-126 — The goal's rules and FR-522's move (2026-10-23, T-213)
ADR-161 keeps a pinned goal on Home even when it sells out (but not once it closes or the player is at its limit) (it says "sold out, pick another"), counts a reward that
opens later as the next reachable one, and moves FR-522 (items as quest or category rewards) to T-304. Agree?

## Q-127 — Confirming results before the end (2026-10-23, T-214)
ADR-163 lets the owner confirm only once the event has ended. A finale held before the official end time would need
the owner to set the end time to the finale. Should confirming also be allowed while live (scans continue, the
prize places freeze)?

## Q-128 — Undoing a confirmation (2026-10-23, T-214)
ADR-163 has no undo: a cheat found after confirming keeps their place (their prize is held at the desk if banned).
Should the owner be able to reopen results before the reveal?

## Q-129 — A winner banned after confirmation (2026-10-23, T-214)
Built: the place stays, the prize is held at the desk and the owner may cancel it; it does not pass to the next
player. Should it pass down instead?

## Q-130 — Rank prize limits and the claim deadline (2026-10-23, T-214)
ADR-162 allows ranks 1–100, item and experience prizes only (no digital codes), and lets the owner pick the claim
deadline at the reveal (default: the desk's last closing, or the shop's closing; 1 hour to 60 days). Agree?

## Q-131 — The official rules' winner wording (2026-10-23, T-214; counsel)
The fixed rules block (`rules.howWinners`) says winners are those with the highest final score "as confirmed by the
organizer after the event ends", ties going to whoever reached the score first, with the team, staff, banned players
and the exclusion list unable to win. Counsel should confirm this wording (Arabic and English) is enough for a
contest's official rules in Saudi Arabia and for Apple 5.3 (with Q-040).

## Q-132 — Today's ranking: when it shows and what counts (2026-10-23, T-216)
ADR-166 shows today's ranking only while a multi-day event is live (not before the start or after the end), turns it
on by default for every multi-day event, and counts every points change of the day (a removal or a rank-lowering
spend today lowers today's points, even for points earned earlier; welcome points given today count toward today too). Agree, or should it count only points earned from quests?

## Q-133 — A declined request: final, or may the player ask again? (2026-10-23, T-218)
ADR-167 makes a decline final for that event (the player sees it was declined and cannot ask again) unless the
organizer lists them as a guest or accepts the declined request later. Agree, or should a declined player be able to
ask again (for example after a day)?

## Q-134 — Can an owner raise the player limit? (2026-10-23, T-218)
FR-1821 lets "the owner (within the limit Questify set)" raise the limit, but no owner ceiling exists: the limit is
set only by Questify (ADR-141). ADR-168 keeps it that way for now: the owner releases people from the waiting list,
Questify raises the limit. Should Questify set a ceiling per event (or per plan) up to which the owner may raise it?

## Q-135 — Pending requests after a switch away from Private (2026-10-23, T-218)
ADR-169 leaves pending requests pending when a Private event becomes Public or Unlisted, for the owner to decide.
Agree, or should the switch accept every waiting request at once (the confirmation would say so)?

## Q-136 — A player outside the audience scans a targeted quest (2026-10-23, T-220)
ADR-170 hides targeted categories and rewards, but a scan of a targeted quest's code answers "This quest is for
another group of players." rather than "not found", because the code is on a physical booth. Agree, or should the
refusal look as if the quest did not exist? (The CTO plan review kept the explicit `not_for_you`; built so.)

## Q-137 — Targeting needs a choice field (2026-10-23, T-220)
ADR-171 adds options to custom join fields and allows targeting by answer only on such a field (free-text answers
would match unreliably). Agree, or should targeting also match free-text answers exactly (after trimming and case)?

## Q-138 — One tag per guest entry (2026-10-23, T-220)
ADR-172 gives each guest entry one optional tag, set for a whole paste. Agree, or do organizers need several tags per
person (a tag list per entry, or a "contact, tag" line format)?

## Q-139 — Targeting single quests (2026-10-23, T-220)
FR-1708 targets categories and rewards; the plan follows it. Should a single quest inside an open category be
targetable too, or is moving it to a targeted category enough? (The CTO plan review kept FR-1708 as written:
categories and rewards only; built so.)

## Q-140 — Deleted points: anonymised, not erased (2026-10-24, T-217)
ADR-175 keeps a deleted player's ledger entries and enrollments, naming no one, so event totals and frozen results stay
right; the player disappears from every profile and board. The privacy policy would say "your points are removed from
your profile and rankings". Agree (this closes Q-086 and Q-092), or must the rows be removed too?

## Q-141 — Fingerprint key and retention (2026-10-24, T-217, with Q-075)
ADR-176 keeps ban marks until the event's data goes and welcome marks until the event ends (platform-ban marks:
indefinitely); the deletion screens and the privacy policy say fingerprints are kept against fraud. The key can never
be rotated without losing the marks. Agree, or should marks expire after a set time (for example 2 years)?

## Q-142 — Handed-over prize records after deletion (2026-10-24, T-217, with Q-051)
ADR-178 keeps handed-over records attached to the anonymised enrollment, so they hold nothing personal. Counsel: is
that enough for FR-128, or must they be deleted after a set period (which would need a ledger exception)?

## Q-143 — Acceptance records and the username after deletion (2026-10-24, T-217, with Q-095)
The plan erases the player's acceptance records and username history, and frees the username for anyone at once.
Agree, or should acceptances be kept as proof of consent (counsel) and the name held back for some days?

## Q-144 — Bulk award reasons (2026-10-24, T-217)
The T-207 note asked to clear `bulk_award.reason` on deletion. A bulk award's reason is about a group, not one player,
so the plan keeps it and clears only the player's own `ledger_note.reason`. Agree?

## Q-145 — The XP amount and the level curve (2026-10-24, T-401)
ADR-180: 100 XP per quest, 30 levels, level n from 50·(n−1)·(n+2) XP (level 5 after 14 quests, level 6 after 20,
level 10 after 54). Agree, or a faster or slower curve?

## Q-146 — The XP a quest gave is not displayed (2026-10-24, T-401)
FR-414: the amount is not displayed. The plan never sends it: the player sees only the XP bar, the level and a level-up
celebration. Agree, or show "+100 XP" after a scan?

## Q-147 — The XP bar before items exist (2026-10-24, T-401)
FR-416 shows the next level's reward; items arrive with T-402. Until then the bar shows only the next level (ADR-182).
Agree?

## Q-148 — Level title names (2026-10-24, T-401)
ADR-181: مستكشف Explorer, مقتفي الأثر Pathfinder, مغامر Adventurer, صائد الكنوز Treasure Hunter, بطل Champion, أسطورة
Legend, one per five levels. Keep, or rename?

## Q-149 — Where Questify's photos are stored (2026-10-24, T-301)
CranL Pro allows one bucket per account and `b7r-media` uses it. Photos are T-301b, blocked until a Questify bucket in
`riyadh-1` exists (ADR-183). Ask CranL for a second bucket (or a plan with more), or use Oracle Object Storage in
Riyadh? Sharing `b7r-media` is not recommended.

## Q-150 — Submission sizes (2026-10-24, T-301)
Text up to 1,000 characters (T-301); for T-301b, photos up to 8 MB uploaded, stored as JPEG of at most
2,048 px. Agree?

## Q-151 — Two new server dependencies (2026-10-24, T-301b)
`sharp` to re-encode photos (strips location data, refuses disguised files) and `aws4fetch` to sign S3 requests
(ADR-185). Agree, or upload straight to the bucket with presigned URLs and no re-encoding?

## Q-152 — Submission retention (2026-10-24, T-301)
A deleted account's submission text is cleared at once (T-301). For T-301b: rejected and removed photos deleted at once; approved photos kept for the event's retention period (Q-075, counsel).
Agree?

## Q-153 — Auto-approved submissions in the queue (2026-10-24, T-301)
ADR-187: they pay at once but stay in the queue as "not yet seen" until a reviewer opens them. Agree?

## Q-154 — Resubmission rules (2026-10-24, T-301)
ADR-188: one pending submission per player and quest at a time; pending counts against the repeat cap; with resubmit
off a rejection closes the quest for that player. Agree?

## Q-155 — Who reviews and who removes (2026-10-24, T-301)
ADR-189: owner, editors and operators with `review` approve or reject; only owner and editors remove an approved one.
Agree?

## Q-156 — Quiz shape (2026-10-24, T-302)
ADR-191: multiple choice only (1 to 20 questions, 2 to 6 choices, one right), one attempt per player, `quest.points` per
right answer. A typed-answer question is not in v1. Agree?

## Q-157 — Quiz timer and grace (2026-10-24, T-302)
ADR-192: one timer per quiz (5 to 300 seconds, or none), measured by the server from serving, with 2 seconds of grace;
no clock between questions. Agree?
Sweep cost (CTO code review, 2026-10-23): each lifecycle tick's `finish_one_due_quiz` walks the open attempts in id
order until the first due one, checking each (`quiz_due`: play phase, quest close, last question's time). The open set
is small (only quizzes in progress) and the `play_phase` branch cannot be pre-filtered in the query, so it stays a
loop; if a large event shows the tick slowing, keep a `due_at` on the attempt and index it.

## Q-158 — Vote options and results (2026-10-24, T-302)
ADR-190 and ADR-195: text options now, images once a Questify bucket exists (Q-149); the team sees counts, players only
their own vote until live polls (T-306). Agree?

## Q-159 — An unfinished quiz (2026-10-24, T-302)
ADR-193: a quiz left half-done is paid for its right answers when the quest closes or the event leaves live. Agree, or
pay nothing for an unfinished quiz?

## Q-160 — T-303 split (2026-10-24, T-303)
ADR-196: T-303 = challenge, survey, share; T-303b = location check-in and the location flags; T-303c = meet-someone.
Agree, or want location or meet-someone first?

## Q-161 — Challenge confirmation (2026-10-24, T-303)
ADR-197: staff confirm by scanning the player's My QR at the station; no queue where a player asks for confirmation.
Agree?

## Q-162 — Survey shape and privacy (2026-10-24, T-303)
ADR-198: choice, rating 1 to 5 and short text questions; the team sees answers with names not shown. Want named answers, more
question kinds, or a different rating scale?

## Q-163 — Share quests default (2026-10-24, T-303)
ADR-199: `shareQuests` is on by default (creating a share quest turns it on); the switch hides them. ADR-034 said the
organizer "turns share quests on"; is on-by-default fine?

## Q-164 — T-304 split (2026-10-24, T-304)
ADR-200: T-304 = category rules and the points bonus; T-304b = passport; T-304c = refresh and hidden categories;
T-304d = item rewards; the hint-push reveal (FR-238) waits for push (T-501). Agree, or want another part first?

## Q-165 — Who the category gates bind (2026-10-24, T-304)
ADR-201: opens-at, unlock-after and in-order bind players and station scans; an owner's or editor's manual award passes
them. Agree, or should manual awards obey them too?

## Q-166 — Completion bonus rules (2026-10-24, T-304)
ADR-202: the bonus is points with no XP, and a removable credit of its own (removing a quest leaves it). Agree, or
should a bonus also give XP, or follow its quests' removal?

## Q-167 — Passport rules (2026-10-24, T-304b)
ADR-203: steps by printed QR only; a scan after the passport is finished refuses; `needed` never falls once anyone has
stamped. Agree, or should staff stamp a step from a player's My QR, or extra stamps count for something?

## Q-168 — Refresh and hidden categories (2026-10-24, T-304c)
**Answered 2026-10-24 (Dhia): agreed as proposed; ADR-204 Accepted.**
ADR-204: weekly blocks start on the event's first day (not a calendar week); a daily unlock category locks its
follower again each day; a scan of a hidden category's quest before its secret code answers `not_for_you`; a staff
manual award of a hidden quest pays and reveals the category to that player; switching a category from daily to none
keeps its bonus paid once (not paid again). Agree, or should weeks follow the calendar, an unlock stay open once
earned, a quest scan reveal its category, or a manual award be refused until the player finds the code?
Note (T-304c code review): the weekly anchor is the event's `starts_at`, so editing the start mid-event moves the
weekly blocks from then on (counts already made stay; the current week may grow, shrink or restart).

## Q-169 — Items as quest or category rewards (2026-10-24, T-304d)
**Answered 2026-10-24 (Dhia): agreed as proposed; ADR-205 Accepted.**
ADR-205: a quest gives its item on the first completion only (a repeatable quest gives points again but no second
item); a daily or weekly category gives its item once per period, with its bonus; an item missed because stock ran out
is not given later when stock is raised (the organizer sees who missed); the player cannot cancel an item they earned;
items are physical only (no experience or digital code); after a quest award is removed, scanning the quest again
pays its points but gives no item (the removed completion still counts, ADR-152). Agree, or should a repeat give another item, a category give
its item once for the whole event, missed players be served first when stock returns, or experiences be allowed?

## Q-170 — Location check-in rules (2026-10-24, T-303b)
ADR-206: a check-in passes inside the quest's radius plus the phone's accuracy (the allowance at most the radius, the
fix at most 2 minutes old and 500 m accurate); a fix the phone marks as mocked still pays and raises a flag; no
coordinates are stored, only rounded distances, accuracy and the mocked mark. Note: a check-in only proves the phone
claimed to be there (all values come from the phone); the speed flag and the QR are the real guards. Agree, or should
a mocked fix be refused, the allowance be stricter, or the exact point be kept for the organizer?

## Q-171 — Location flag numbers (2026-10-24, T-303b)
ADR-207: "far from the venue" when the fix is more than the venue radius (default 1 km) plus 1 km away after its
accuracy; "impossible speed" above 15 m/s (54 km/h) between quest spots at least 300 m apart; one reading is enough to
raise a case (people decide). The stored distances follow the event's data retention (Q-075). Times are when the
server received each scan, so a retry delayed by a bad connection can bunch two scans and look fast; the Flags page
shows the gap and seconds per scan against the player's previous placed scan, and a person decides. Agree, or other
numbers, or several far readings before a case?

## Q-172 — Asking for location, and the switch (2026-10-24, T-303b)
ADR-208: the app asks when the player taps "Check in" on a location quest and once right after joining an in-person
event with a venue pin, never at launch. Its explanation sheet has one "Continue" button that always opens the system
prompt: Apple rejects a pre-permission screen with a "Not now" exit or an "Allow" button under 5.1.1(iv) ("the user
should always proceed to the permission request after the message", App Review replies quoted on Apple Developer
Forums, 2026; HIG Privacy). Location quests stay behind a platform switch that is off until you update the App Store
privacy label and Play's Data safety form for location, and CranL's database is confirmed not to log query
parameters. Agree, or ask only from a location quest, or turn the switch on now?
Sources (checked 2026-10-23): the App Review reply is quoted in the Apple Developer Forums thread "App Rejected – Guideline 5.1.1(iv) – Location Permission Pre-Prompt With “Not Now” Button" (March 2026), listed at https://developer.apple.com/forums/tags/maps-and-location?page=2 (the thread's own address was not found); the rule itself: https://developer.apple.com/app-store/review/guidelines/#5.1.1 and https://developer.apple.com/app-store/review/guidelines/#5.1.5 ; Apple HIG, Privacy: https://developer.apple.com/design/human-interface-guidelines/privacy ; a second report of the same rejection (an "Allow" button and "Not now" both refused): https://dev.to/hokagedemehin/shipping-to-both-stores-the-release-runbook-29ma

## Q-173 — Meet-someone proof (2026-10-24, T-303c)
ADR-209: since My QR is fixed (ADR-137), a meet quest uses its own code: shown from the meet quest in the app, alive for
one minute, used up by the first meeting, and both players are paid together or not at all. Meeting needs a connection
on both phones. Agree, or a longer life, a typed fallback, or the shown player confirming each meeting in their app?
Also (build, 2026-10-23): should the app raise the screen's brightness while the code shows? It needs `expo-brightness`, a native module, so a new EAS build; without it a dim phone may scan slower.

## Q-174 — Meet-someone rules (2026-10-24, T-303c)
ADR-210: one meeting per pair per quest; a daily cap per player (default 5, 1 to 50) counting the meetings they took
part in on either side; if either player is at a cap or cannot play the quest (a suspended account, an operator who
may not play, outside the audience), neither is paid; the event's meet-someone switch is on by default; allowed
in virtual events too (meeting over video). Agree, or a different default cap, or no meet quests in virtual events?

## Q-175 — Meet-someone cheating signals (2026-10-24, T-303c)
ADR-211: the scanner's side counts in the usual flags (same phone, burst, far from the venue); the shown side only in
the same-phone check; one phone on both sides is refused; no check of the distance between the two players, since that
needs both positions kept (ADR-206 keeps none); no new flag kind yet. The meet records follow the event's data
retention (Q-075) and are deleted with either account. Agree, or should a "same small group meeting only each other"
case be added later?
Known edges left as they are (CTO code review, 2026-10-23): the per-player limits answer 429 when two of the player's requests contend for the limiter's lock at the same instant (a retry passes); and one Idempotency-Key used for a meeting and for an ordinary completion is not refused as reused (`QK422`): each pays once under its own path, never twice.

## Q-176 — How far mini-game results are checked (2026-10-24, T-305)
ADR-212: the server replays every round and refuses impossible play, but the round's layout reaches the phone, so a
modified app could play a perfect game at human speed. The targets sit below perfect play, very lucky rounds are
flagged for the organizer, and the reward is one quest's points once. An app with an older game engine is asked to
update before it can play. Agree, or ask the server for each move (slower on a venue network)?

## Q-177 — Mini-game attempts and retry (2026-10-24, T-305)
ADR-213: an attempt is used when Play is tapped, so quitting a bad round does not give a fresh one; a result that could
not be sent is kept in the app's memory for the time limit plus 10 minutes (an app closed in between loses it); a round
already started may finish after the organizer switches mini-games off; once anyone has played, the organizer can
change the game's points but not its game, level or attempts. Agree?

## Q-178 — Mini-game levels (2026-10-24, T-305)
ADR-215 and the plan's table: memory match 6, 8 or 10 pairs in 120 seconds (medium within 20 moves, hard within 22);
slide puzzle 3×3 lightly or fully shuffled in 180 seconds, or 4×4 in 300 seconds. A round is flagged as unlikely after
3 lucky first-sight matches on easy and 4 on medium and hard (built 2026-10-24: 3 flagged over 1% of honest rounds at
the larger boards), or a puzzle solved in fewer moves than its shuffle at under 300 ms a move. Keep as a start and tune
after a playtest?

## Q-180 — A mini-game result sent after the event ends (2026-10-24, T-305 code review)
A round finished just before the event's end, whose result could not be sent, is refused once the event has ended:
`finish_game_round` re-checks that the player may still play (`quest_open_check` answers `ended`), writes nothing, and
the sweep then closes the round as played at its deadline. That cuts FR-1809's 10-minute Retry short at the event's
end (and at the quest's own close). **Recommended (Proposed):** take a result inside its window when the round was
issued while the quest was open, re-checking only the account, the membership and that results are not final (the
quiz's payable rule, `game_payable`), as a quiz finished by the sweep after the event ends still pays. Agree?

## Q-179 — Mini-games in three parts (2026-10-24, T-305)
ADR-214: memory match and slide puzzle first (T-305), catch and tap rush next (T-305c), organizer images once a
Questify bucket exists (T-305b, blocked on Q-149). Agree?

## Q-181 — How catch and tap rush are checked (2026-10-24, T-305c plan)
ADR-216 and ADR-217: the two real-time games move on a fixed tick so the server replays them exactly; a tap on a
target in its first 120 ms is ignored by the app (no person reacts that fast); fast but possible play is flagged for
the organizer and still paid; a round pauses while the app is not active, within its result window. Note: catch's
"foreseen" flag only catches a naive seed reader; one that waits 133 ms or more, or is already in position, is never
counted, so the flag is advisory only. Agree?

## Q-182 — Catch and tap rush levels (2026-10-24, T-305c plan)
ADR-218 and the plan's table: catch 45 s with 30, 40 or 50 items (pass at 20, 30 or 40 caught); tap rush 30 s with a
score of 20, 28 or 34 to pass, a miss costing a point. Keep as a start and tune after a playtest?

## Q-183 — Splitting T-306 (2026-10-24, T-306 plan)
ADR-219: live polls now (T-306); community quests next (T-306b); quests, categories or shop rewards unlocked by a
community goal after that (T-306c). The pushes wait for T-501 and the big-screen scenes for T-504. Agree?

## Q-184 — Live poll rules (2026-10-24, T-306 plan)
ADR-220: a live poll takes one choice or several (several still count as one vote and one payment), shows results
after voting, at close or never, and stays open 1 minute to 24 hours once sent (never past the event's end). A poll
never counts toward a category's bonus or order, so missing one blocks nothing. A poll without points still gives
Questify XP like any quest. Agree, or no XP for a poll without points?

## Q-185 — Polling instead of a live stream (2026-10-24, T-306 plan)
ADR-221: the app checks for live polls and community progress every 10 seconds while the event is open on screen;
the live stream waits until the big screen or a load test needs faster updates. Agree?

## Q-186 — Community quest rules (2026-10-24, T-306 plan)
ADR-222: one community quest running at a time per event; the list of who gets the reward is fixed the moment the
goal is reached (people who join later are not paid); "everyone" means every active player at that moment; community
quests do not run in rehearsal (the dashboard shows a preview). Agree?

## Q-187 — Community payout numbers (2026-10-24, T-306 plan)
ADR-223: rewards paid in batches of 500 players, up to 2 seconds of work every 5 seconds (10,000 players paid within
about 30 seconds); final results wait until every community reward is paid, and the owner can press "Settle and pay now" instead of
waiting. Keep as a start?

## Q-188 — Seeing the server's own open transactions on CranL (2026-10-24, T-306b plan) — closed as moot
Closed 2026-10-24 (CTO plan review 1): CranL's owner `admin` is a superuser (STATE.md, T-003) and so is CI's
(`test-db.ts`), so it already sees the API's sessions. Migration 0053 grants nothing; it checks the owner can see them
and stops with an error otherwise (ADR-224).

## Q-189 — Community counting details (2026-10-24, T-306b plan)
ADR-225: in a points goal, a player who earned 0 points has not taken part; reaching the goal ends it early (nothing
is left to count); a finished goal stays on the event home for 30 minutes. Agree?

## Q-190 — Turning community quests off (2026-10-24, T-306b plan)
ADR-226: off for one event ends a running goal at once (rewards already reached are still paid); off for the whole
platform only hides community quests and lets running goals finish and pay. Agree? Note (CTO plan review 4): ending it
at once means a player whose scan was still being saved at that second is not added to a reward already reached.

## Q-191 — When an unlock locks its item (2026-10-24, T-306c plan)
ADR-227: a community goal's unlock locks its quest, category or shop reward as soon as the goal is saved, even before
the goal starts; staff with an award limit cannot hand it out while locked, owners and editors can. Agree?

## Q-192 — Showing a locked item (2026-10-24, T-306c plan)
ADR-228: a locked quest or shop reward is shown as locked with "Unlocks at 5000 community points" (a teaser), not
hidden until it unlocks; the public event page hides it. Agree, or hide it everywhere until unlocked?

## Q-193 — A missed unlock (2026-10-24, T-306c plan)
ADR-229: if the community misses the step, the item stays locked for the rest of the event, with no "Unlock now"
button; switching community quests off for the event ends its running goal as missed, so what it would unlock stays
locked for good (the switch warns); during a rehearsal locked items stay locked. Agree, or add an owner's "Unlock now"?

## Q-194 — The category bonus when a lock is missed (2026-10-24, T-306c build)
ADR-227 build note: when a community goal misses a step that locks one quest of a category, that quest no longer
counts toward the category's bonus. A player who already finished every other quest of the category gets the bonus
with their next completion there, and not at all if nothing is left to complete (the bonus is paid by a completion,
never by the goal). Agree, or should the goal pay those bonuses when it is missed?

## Q-195 — Flash quests (2026-10-24, T-307 plan)
ADR-231: a flash quest is hidden from players before and after its window (and never shown on the public event page),
lasts at most 24 hours, and is launched once; a missed flash quest never blocks a category's bonus or what unlocks
after it, and doing one does not count toward the bonus. Agree?

## Q-196 — What a boost doubles (2026-10-24, T-307 plan)
ADR-232: a boost always doubles (×2), on one category, never overlapping another on it; the category bonus, community
rewards and points handed out by staff are never doubled (staff top up with a point award if a scan failed during a
boost). Agree, or should a staff award of a quest during a boost be doubled too?

## Q-197 — When a boost applies (2026-10-24, T-307 plan)
ADR-233: a submission sent, a quiz started or a game begun during a boost gets double points even if it is approved or
finished after the boost ends; turning boosts off for the event stops doubling at once, including for submissions
still waiting for review; a community points goal counts the doubled points; the player's pending points already show
the doubled amount. A test boost set up during the rehearsal doubles only the test accounts and is removed at go-live.
Agree?

## Q-198 — Signed NFC tags (2026-10-24, T-308 plan)
**Answered (Dhia, 2026-10-24):** "we will go only with [basic tags]. The other option we will not do it at all." Basic
tags only (NTAG213/215); signed tags are not built. ADR-040 stands; ADR-235 and ADR-236 rejected.

## Q-199 — Basic NFC tags (2026-10-24, T-308 plan)
ADR-234: a basic tag that seems copied (its id is not the one registered when it was written) is flagged and still
pays, as every other flag; NFC is offered only on scan quests, always with their QR on. Agree, or should a copied basic
tag be refused, or NFC be allowed on location quests too?

## Q-200 — Signed tag replay window (2026-10-24, T-308 plan)
**Closed (moot, 2026-10-24):** signed tags will not be built (Q-198).

## Q-201 — What a kiosk reads (2026-10-24, T-309 plan)
ADR-242: kiosks read a live code from a "For kiosks" tab in My QR (online only), so an expired screenshot never pays.
Agree, or should kiosks read the fixed My QR as stations do, accepting ADR-137's risk with no one watching?

## Q-202 — The big-screen link (2026-10-24, T-309 plan)
ADR-241: the link is a plain address and the screen needs pairing; "Revoke all big screens" replaces "regenerate the
link". Agree, or a link with a token that pairs the screen by itself (no staff step, but anyone holding the link opens
it)?

## Q-203 — Screen QR rhythm (2026-10-24, T-309 plan)
ADR-240: a 30-second code with 15 seconds' grace, never together with the printed QR (so not with NFC, which needs the
printed QR). Agree, or another rhythm (FR-314 allows 30 to 60 seconds), or allow NFC with the screen QR as its backup?

## Q-204 — Who pairs devices (2026-10-24, T-309 plan)
ADR-239: operators pair stations with `show_rotating_qr` and kiosks with `scan_quests`; big screens only from the
dashboard; removing an operator revokes what they paired. Agree, or a separate `pair_devices` ability (off by default),
or pairing from the dashboard only?

## Q-205 — Blank stickers without a read-back (2026-10-24, T-308 phone-test fix)
ADR-243: a factory-blank sticker is formatted with the Questify link in one step and trusted on Android's success,
with no read-back before the server registers it. Agree, or format first and ask the operator to tap again for the
write and its read-back?

## Q-206 — The screen code's tuning knob (2026-10-24, T-309 build)
The platform tuning `screenQrRotationSeconds` (default 45, 30 to 60) predates ADR-240, which fixes the window at 30
seconds with 15 seconds' grace on the database clock; the code does not read the knob. Remove it, or make the window
follow it (the window then has to be read inside the door at judging time)?
**Answered (CTO code review, 2026-10-24):** removed; ADR-240 fixes the window at 30 seconds.

## Q-207 — The wallet pass at kiosks (2026-10-24, T-309b plan)
F-274 says stations, kiosks and the prize desk accept the wallet pass's fixed ID code; ADR-242 makes kiosks read only
the live code (a fixed code works from a screenshot for ever, and no one watches a kiosk). Recommended: kiosks refuse the
pass's fixed code as they refuse My QR (stations and the prize desk still accept it), and F-274 is amended when the pass
is built. Or should kiosks accept the pass, with ADR-091's risk and no one watching?

## Q-208 — What a kiosk shows of the player (2026-10-24, T-309b plan)
ADR-244: a kiosk's green and orange cards show the @username and avatar (both public on the boards already); red names
no one. Agree, or show only the colour and the points, so a bystander learns nothing?

## Q-209 — The help desk's two kinds and the ticket center's four types (2026-10-24, T-310 plan)
T-310 stores `question` and `problem` (a problem at the event, such as a missing QR). FR-1822 has four types: report a
player, app problem, suggestion, question or prize problem. Recommended: T-312 shows four cards and "Question or prize
problem" becomes "Question or problem at the event", holding both stored kinds, so nothing is migrated. Or should
problem reports be a fifth type?

## Q-210 — Help-desk ticket retention (2026-10-24, T-310 plan, with Q-075)
ADR-248: tickets are deleted 90 days after the later of their event's end and their sending (sending closes 30 days
after the end; prize claims run up to 60 days), and at once with the account. Agree, or keep them longer for disputes?
Closed part (CTO code review, 2026-10-24): no ticket escapes the sweep, since every event out of draft has an end
(`event_times_once_active`) and tickets cannot be sent in a draft. The length (90 days) stays open for Dhia and counsel.

## Q-211 — Questify's access to tickets before escalation (2026-10-24, T-310 plan)
ADR-247: until T-312, no Questify admin can read an event's tickets, even for abuse or a legal request (only the
database owner can, as for every table). Agree, or add a logged console read now?

## Q-212 — Practising more than station scans (2026-10-24, T-311 plan)
ADR-250: practice mode covers the station scan only; the desk, manual awards, reviews, ticket answers, NFC writing and
pairing are locked while it is on. Recommended: keep it so until an organizer asks to train desk or award staff. Agree?

## Q-213 — Whose completions "My station today" counts (2026-10-24, T-311 plan)
ADR-251: the block counts every completion of the station's quest today (all methods, all operators); the station list
keeps this operator's own counts. Agree, or should the block count only this operator's scans?

## Q-214 — Staff mode does not use the event's renamed words (2026-10-24, found in the T-311 plan)
T-117 marked FR-941 delivered, but staff mode (built later in T-205) never loaded the event's configuration, so its
screens used Questify's default player, operator and currency words. **Built in T-311b (ADR-254, Proposed):** staff
mode loads the event's words with the player app's source. Agree?

## Q-215 — The dashboard builder still says "quest" and "category" (2026-10-24, T-311b)
**Answered 2026-10-25 (Dhia): split it to T-311c, done later.**
FR-942 says the renamed words apply "everywhere in that event". T-311b renamed them in the player app and staff mode
(about 85 texts, with the Event words section and its preview). About 110 organizer-facing texts remain (the quest
builder, codes, operators, audience, community, flash, boosts, quest items, awards, devices pages), each needing
ADR-253's rule and a web test. Recommended: T-311c, Standard bar, after Dhia reads the Arabic lines of ADR-253.

## Q-216 — An operator who never joined a private event sees Questify's own words (2026-10-24, T-311b)
`GET /v1/events/{id}/config` answers a player for a public event, or for an event they joined. An operator of an
unlisted or private event who never joined it as a player gets 404, so staff mode shows the defaults. Recommended: leave
it until it happens (operators join through the operator card, T-205; the operator-invite screen, which runs before they
join, also shows the defaults); if it does, widen the event read to the event's
operators in a migration with an outsider test.

## Q-217 — Arabic lines for Dhia's eye (2026-10-24, T-311b)
The lines most worth a read are in ADR-253: «{questOne} للجميع» (community quest), «{questOne} بوقت محدود!» (flash
quest), «المحطة غير متاحة الآن» (operator cards), «انتهى الوقت المحدد», «المستلم» (manual award search), «لا شيء في نطاق
عملك يعرض رمز QR على شاشة», «بالترتيب: يفتح كل عنصر ما بعده». Several Arabic lines no longer name the quest at all.

## Q-218 — What "take over any ticket" means (2026-10-24, T-312 plan)
ADR-258 reads FR-1823's "the Questify team shall be able to ... take over any ticket" as "answer any ticket in
Questify's queue", never a ticket that was not routed or escalated to it (otherwise Questify reads every event's
tickets). Agree, or should Questify see every ticket?

## Q-219 — Where a report of a player goes (2026-10-24, T-312 plan)
FR-1411 sends a report to the event team and Questify's moderation queue; FR-1822's acceptance says a Report a player
ticket reaches the event team and not the Questify queue. Built: the event team only; T-705's moderation queue (reports
of content and usernames) is where Questify sees reports. Agree?

## Q-220 — Keeping tickets with no event (2026-10-24, T-312 plan)
App problems and suggestions are deleted 90 days after their closing; an open one waits in the console and is never
deleted by age (CTO plan review, 2026-10-25). Agree, or keep app problems longer for bug history (without the text)?

## Q-221 — Counsel: Questify reading an escalated ticket (2026-10-24, T-312 plan, with Q-075 and Q-210)
T-310 told players "Only you and the event team can see this". With escalation the line becomes "... If they ask
Questify for help, the Questify team can see it too", shown before sending. Does the privacy policy need more?

## Q-222 — Operators escalating (2026-10-24, T-312 plan)
ADR-258: only owners and editors escalate; an operator asks them. Agree, or let operators with `help_desk` escalate?

## Q-223 — A removed first-N bonus keeps its slot (2026-10-25, T-313 plan)
A removal (cheating, a mistake) keeps the slot used, so the organizer's N is the most ever paid. Agree, or should
removing the bonus line give the slot back to the next completer?

## Q-224 — One first-N bonus per player per quest, ever (2026-10-25, T-313 plan)
Also on repeatable and daily quests. Agree, or should a daily quest have "first N each day"?

## Q-225 — Manual quest awards and the first-N bonus (2026-10-25, T-313 plan)
A team award takes no slot and pays no bonus (as boosts), so a player whose first completion was a team award can never
get the bonus (a later scan is a repeat); for submissions the approval order decides who is first. Agree, or should a
team award count as one of the first N?

## Q-226 — At most 1,000 players per first-N bonus (2026-10-25, T-313 plan)
Enough, or raise it (the slot rows grow with N; 10,000 is still small)?

## Q-227 — Pages that cannot read the event's words keep Questify's (2026-10-25, T-311c)
The public page of a printed code (`/q/{token}`), the kiosk page (`kiosk.notOpen`, `kiosk.methodOff`) and the big
screen's "closed" lines (`device.shut.*`) do not load an event's configuration, so a renamed event still shows "quest"
there. The Event words form names the concepts it renames, so it keeps them too. Recommended: leave it until the kiosk
and big screen read the event's configuration (T-5xx), then fill the words the way the app does. Agree?

## Q-228 — The dashboard still says "player" in about 100 texts (2026-10-25, T-311c)
FR-941 asks the dashboard to use an event's renamed "player" word everywhere; T-117 did the page titles and a few
fields. About 100 texts the dashboard names (rewards, prizes, flags, guests, join setup, results) still say "player",
and the same goes for "operator". T-311c did the quest and category words only, as asked. Recommended: a T-311d that
turns them into `{playerOne}`/`{playerMany}` placeholders with the same guard test, Standard bar. Agree?

## Q-229 — The first-N bonus's burst cost is over the plan's 20% (2026-10-25, T-313)
Measured by hand (ADR-260): at 300 completions at once on one quest from two API pools of 10, the median p95 is 59.7 ms
without a bonus and 73.2 ms with N = 50 (+22.7%, 13 ms); a used-up bonus costs nothing (60.0 ms). The slot claim alone
is +7.5%; the rest is the bonus's own ledger row for the first 50 players. Recommended: accept it (NFR-002 allows 1 s;
the extra lasts only for the first N), and keep the bonus as its own ledger kind. The alternative, folding the bonus into
the quest's entry, would lose its own removal, label and community count. Agree? The CTO code review (92, GO)
recommends "agree", with the timing measured again if Q-226 raises the 1,000 cap (a larger N means more first claims).

## Q-230 — Split souvenirs from profile ownership (2026-10-25, T-402 plan)
Recommended (ADR-266): T-402 builds owned cosmetics, per-level grants and private/public profiles; T-402b immediately
after it builds the organizer's souvenir dashboard/rules/grants (FR-723/1622). T-403 finishes FR-701/702's real
achievements/passport and owner history; private-event stamp disclosure needs its own explicit plan decision.
Everything remains in v1. Agree with the decomposition?

## Q-231 — Questify-wide signed-in public profiles (2026-10-25, T-402 plan)
Recommended (ADR-267): any active signed-in player can open another active player's public profile by current
username without sharing an event, but only username, character, frame, equipped title and level are returned now;
T-403 adds only public-safe achievements/passport. Deleted/platform-banned targets answer the same 404 as missing;
contacts, XP, event history and locker sources stay private. A rename makes an old link unavailable. Agree?

## Q-232 — First level-reward catalog (2026-10-25, T-402 plan)
Recommended (ADR-268): a treasure-chest character at level 4 using existing art; frames at the other even levels;
titles at odd levels, 29 distinct items for levels 2–30. This makes every historical/new level grant concrete without
waiting for more art or a media bucket. Six starters stay free; the equipped cosmetic title is separate from the
automatic level-range title. Agree with this starting mix, or prefer a different guaranteed reward order?

## Q-233 — Frozen souvenir targets and once-ever finishers (2026-10-25, T-402b plan)
Recommended (ADR-269): activate an explicit permanent promise with a distinct item and frozen nonempty quest set;
later quest edits do not change it. Category/every-quest souvenirs use done evidence across all event periods,
including existing quiz/game terminal completion rules, and award once. Joined means approved active real membership,
not proof of attendance. Stop affects future grants only. Keep the100-rule cap and existing shipped frame/chest art?

## Q-234 — Durable automatic souvenirs and private event sources (2026-10-25, T-402b plan)
Recommended (ADR-270): small automatic batches grant outside the scan transaction; the dashboard shows pending work
and can safely request another processing pass. Own locker shows the event privately, even after leaving/archive;
equipped cosmetic names/art can be public, but event names are never copied into them automatically. Rehearsals earn
none and erasure removes ownership/provenance/work. Agree with eventual delivery using the existing DB/tick runtime?

## Q-235 — Rank souvenirs wait for confirmed results (2026-10-25, T-402b plan)
Recommended (ADR-271): set rank rules before owner confirmation; extend the preview/frozen snapshot up to their
highest rank (maximum100), even if physical prizes are off. After event end show waiting-for-confirmation, then grant
from those frozen ranks. Refuse newly activated rank rules on already confirmed events; do not reconstruct missing
places from current scores. If a winner becomes ineligible before delivery, skip without moving the next player up.

## Q-236 — Finite souvenir repair passes instead of a repeating sweep (2026-10-26, T-402b review repair)
Recommended (ADR-272): scan existing members once at activation (once the event is live) and once per 'Process
pending grants' request, then rely on triggers for every later fact; rank souvenirs wait for confirmed places with no
member scan. The dashboard reads complete once that work drains. Agree that Process pending grants is the manual repair
path, with no automatic periodic re-scan?
**Answered (developer, delegated by Dhia, 2026-10-27):** yes, ADR-272 accepted as built: Process pending grants is the manual repair path, no periodic re-scan.

## Q-237 — Cached idempotent replay before event-scope checks on other organizer routes (2026-10-26, T-402b review)
The independent T-402b review noted that other event-scoped `idempotent: true` organizer routes (for example
`apps/api/src/awards/routes.ts:52-61`) likely replay a cached response from the global preHandler
(`apps/api/src/conventions.ts:82`) before their handler re-checks the editor's current event scope. Souvenir routes
authorize in preValidation first (T-402b). Recommended: one central fix rather than per-route copies, such as an
organizer-scope preValidation that authorizes the `:eventId` parameter for the current session before any replay, with
the souvenir revocation regression reused for every such route. Not changed by T-402b; needs its own task and review.

## Q-238 — Fixed API refusal wording ignores an organizer's renamed quest and category words (2026-10-26, T-402b Arabic review)
The builder's 409 refusals (`categoryNotEmpty`, `boostInUse`, `goalInUse` and the new `SOUVENIR_IN_USE`) use Questify's
default words «مهمة» and «فئة» because the dashboard shows an API message as sent and cannot fill the event's
`{questOne}`/`{categoryOne}` placeholders (FR-942, `terms.quest`/`terms.category`). An organizer who renamed them sees the
default word in these refusals. Recommended: later, let the dashboard map the error code to a placeholder-aware
messages.ts text instead of showing the API string, for all of these refusals together. Not a T-402b change.

## Q-239 — Split T-403 in three (2026-10-26, T-403 plan)
Recommended (ADR-273): T-403 core server (achievements, passport, history, city), T-403b core Questify quests and
console API, T-403c standard screens and copy on a cheaper model, with one code review that includes the Arabic pass.
Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** yes, ADR-273 accepted; the three tasks are built and reviewed.

## Q-240 — Achievement thresholds and Questify quest rewards (2026-10-26, T-403 plan)
Recommended (ADR-279): events 1/5/15, quests 10/50/200, cities 2/4/8, top-10 1/3/10, community goals 1/5/15; seeded
quests "attend 3 events" and "play in 2 cities" at 300 XP each (3 event quests' worth); no items or gems until T-404.
**Answered (developer, delegated by Dhia, 2026-10-27):** ADR-279 accepted with these thresholds and 300 XP each; items and gems wait for T-404.

## Q-241 — What counts as playing an event, and earned is permanent (2026-10-26, T-403 plan)
Recommended (ADR-274): an event counts once the player has a quest XP credit there that was not removed, outside
rehearsal and not on a banned or removed membership (the same rule for all five achievements). Tiers and Questify awards
are kept even if a later removal drops a count below the threshold, and a banned fraudster keeps them until T-709 adds
an admin revoke. Rewards are checked when the app syncs (opening Profile or Questify quests, on foreground, about 15
seconds after scans), not inside the scan. Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** yes, ADR-274 accepted as built.

## Q-242 — Final rank on the passport (2026-10-26, T-403 plan)
Recommended (ADR-275): snapshot every ranked member's place when the owner confirms results; show it after the reveal.
An event whose results are never confirmed shows "results not final" forever. Should unconfirmed events show a rank
after some time instead?
**Answered (developer, delegated by Dhia, 2026-10-27):** ADR-275 accepted as built: no rank until the owner confirms results; an unconfirmed event keeps "results not final".

## Q-243 — Private events on the public passport (2026-10-26, T-403 plan)
Recommended (ADR-276, amended by the plan review): other players see a stamp only once the event has ended or been
archived, and only while it is public and not a workplace event; never while it is live (a live stamp would tell anyone
where the player is now). Private, unlisted and workplace stamps are visible to the owner only, marked "only you see
this". Tiers still count them. Agree, or offer a per-stamp choice later?
**Answered (developer, delegated by Dhia, 2026-10-27):** yes, ADR-276 accepted as built; no per-stamp choice for now.

## Q-244 — Event city list (2026-10-26, T-403 plan)
Recommended (ADR-277): a seeded list of about 20 Saudi cities that organizers pick from (none for virtual events),
frozen once live. Which cities should the first list hold, and who adds new ones (Questify admin)?
**Answered (developer, delegated by Dhia, 2026-10-27):** ADR-277 accepted: the seeded list of Saudi cities as built; a Questify admin adds new ones.

## Q-245 — Seasonal windows and the "follow Questify" quest (2026-10-26, T-403 plan)
Recommended (ADR-278): a campaign is published before it starts; seasonal quests count plays inside the window only,
with a 3-day grace to pay a late sync. Follow
Questify is not built: XP for following a social account outside the app may conflict with App Store 3.2.2(x), on top
of Meta's rule (ADR-034). If you accept that risk and give the account links, it is a small later addition.
**Answered (developer, delegated by Dhia, 2026-10-27):** ADR-278 accepted as built (3-day grace); Follow Questify stays unbuilt because of the store risk.

## Q-246 — Questify quest console rules, and ADR-093's "seasonal campaigns" (2026-10-26, T-403b build)
Recommended (ADR-280): a quest's campaign never changes after creation; an active quest stays active until retired;
drafts are retired rather than deleted; the seeded "attend 3 events" and "play in 2 cities" quests (300 XP each) go
live with the deploy, so players who already qualify are paid at their next sync. Also: ADR-093 (accepted) lists
"seasonal campaigns" as not in v1; the build reads that as seasonal configuration (themes, settings), not FR-711's
seasonal Questify quest campaigns, which the approved plan builds. Agree, or should the seeded quests start as drafts?
**Answered (developer, delegated by Dhia, 2026-10-27):** ADR-280 accepted as built; the seeded quests go live with the deploy; ADR-093 is read as seasonal configuration only.

## Q-247 — T-403c: seeded names, public badge names, points on the history (2026-10-26, T-403c build)
1. The Arabic pass over the seeded names (migration 0065, the app shows the API's text as sent): رحّالة, صائد المهام,
   جوّاب المدن are fine. Recommended: "نخبة العشرة" becomes "العشرة الأوائل" (the natural Arabic for Top Ten) and
   "يدٌ واحدة" loses its tanween mark ("يد واحدة"). 0065 is undeployed, so the two seed values can change in place;
   Done 2026-10-26 (T-403c close-out): both applied in 0065 in place; no test pinned the old names.
2. The public profile's `achievements` hold ids and tiers only. The app reads the viewer's own catalog for names and
   art. Recommended: leave it. Alternative: add `name` and `visualKey` to the public DTO (an API change).
3. The history shows no points (the event's currency word is not in `GET /v1/me/event-history`). Recommended: leave it;
   add the currency's name and icon to the answer only if a points line is wanted.
4. Needs a phone check once a build exists: release Hermes, right to left, Reduce Motion, the toasts and the level-up
   card, the badges at 64 pt.
**Answered (developer, delegated by Dhia, 2026-10-27):** items 2 and 3 left as built (ADR-281 accepted): public badges stay ids and tiers, the history shows no
points. Item 4 stays open until a phone build exists.

## Q-248 — Publishing a campaign has no confirmation (2026-10-26, T-403c review)
Publishing a Questify campaign from the console is one-way (it can only be retired afterwards) and starts paying XP to
real players, yet the button acts at once. Recommended: ask for a confirmation first, as the retire dialog does, saying
it cannot be undone.
**Answered (developer, delegated by Dhia, 2026-10-27):** confirm first (ADR-283); built 2026-10-27.

## Q-249 — Split T-404 into a core part and a screens part? (2026-10-27, T-404 plan)
Recommended (ADR-284): T-404 builds the gem ledger, payments, shop and purchase door (core); T-404b builds the app
screens, the console Gems field and the strings (standard, cheaper model). Agree, or build it as one task?
**Answered (developer, delegated by Dhia, 2026-10-27):** split as recommended (ADR-284); T-404 core is built and reviewed, T-404b follows.

## Q-250 — How the gem ledger works (2026-10-27, T-404 plan)
Recommended (ADR-285): an append-only gem record with only four sources (level-up, achievement, Questify quest, shop
spend), no transfers, gifts, corrections or expiry, and gems never shown to other players. Agree? An admin correction
(for example taking gems from a proven cheater) would need a later task.
**Answered (developer, delegated by Dhia, 2026-10-27):** yes, ADR-285 as built; an admin correction source waits for a later task.

## Q-251 — When and how many gems are paid (2026-10-27, T-404 plan)
Recommended (ADR-286): 20 gems per level-up; 10, 25 and 50 for bronze, silver and gold achievement tiers; 25 for each of
the two seeded Questify quests (other quests set their own, 0 to 1000). Paid at the next sync (seconds after a scan),
and paid back for levels players reached before gems existed. Agree with the amounts and the back pay?
**Answered (developer, delegated by Dhia, 2026-10-27):** yes, ADR-286 amounts and back pay as built; the amounts are data and can be tuned later.

## Q-252 — Gem shop rules (2026-10-27, T-404 plan)
Recommended (ADR-287): one copy of each item per player; an item sold in the shop is never also a level reward or a
souvenir; a tap made at an old price is refused and the app asks again; retired items stay owned. The catalog is set in
the database until the console can edit it (T-709). Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** yes, ADR-287 as built.

## Q-253 — What the shop sells at launch (2026-10-27, T-404 plan)
Recommended (ADR-288): six frames in six new designs and six titles; titles 40 to 80 gems, frames 80 to 150. No
characters until new character art is made (FR-726 partial for characters). Agree, or commission character art first?
**Answered (developer, delegated by Dhia, 2026-10-27):** ADR-288 as built: six rings and six titles; characters wait for new character art.

## Q-254 — Shop wording for the stores (2026-10-27, T-404 plan)
Recommended (ADR-289): the button says "Get" (احصل عليه), not "Buy"; no "add gems" button anywhere; the shop says gems
are earned by playing and cannot be bought. Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** yes, ADR-289; the wording is built in T-404b.

## Q-255 — Small T-404 build choices (2026-10-27, T-404 build)
Recommended (ADR-290): a gem purchase needs a UUID request key; the console's quest Gems value may be left out (keeps the
old value) until T-404b adds the field; the locker says when an item came from the gem shop; the profile shows the
player's own gem count; the twelve seeded item names in ADR-290 (shop frames are called "rings", حلقة, so none looks
like a level frame). Agree, or change any name or price?
**Answered (developer, delegated by Dhia, 2026-10-27):** agreed as recommended (ADR-290 Accepted, CTO code review GO 93).

## Q-256 — Accept two rare deploy-time lock clashes in migration 0067? (2026-10-27, T-404 build)
Recommended (ADR-291): keep the reviewed lock order. If a player's sync or locker read happens at the exact moment the
migration runs, the database may cancel one of them; the app retries, or the deploy is run again. Nothing is lost.
A retry loop inside the migration would remove this; worth building before real players?
**Answered (developer, delegated by Dhia, 2026-10-27):** accept the windows now (ADR-291 Accepted); the migration runner
retries a migration on 40P01 or 55P03 up to 3 times before the first real player (T-022).

## Q-257 — How the gem shop asks and buys (2026-10-27, T-404b build)
Recommended (ADR-292): the shop opens from the Profile and the locker; "Get" asks first in a sheet; a changed price asks
again in the same sheet; too few gems says how gems are earned and nothing else; a bought item offers "Equip now"; a new
key for every confirmation. Agree, or should the Shop tab (T-408) be the only door?
**Answered (developer, delegated by Dhia, 2026-10-27):** agreed as recommended (ADR-292 Accepted, code review GO 91); the phone check of the sheet is owed (T-806).

## Q-258 — Gem wording in Arabic and the six rings' colours (2026-10-27, T-404b build)
Recommended (ADR-293): the Arabic counts and forms in ADR-293, "Get" as احصل عليه, "Equip now" as فعّله الآن, and the six
ring colours (purple, teal, crimson, terracotta, mauve, midnight blue). Agree, or change any word or colour once seen on a
phone?
**Answered (developer, delegated by Dhia, 2026-10-27):** agreed as recommended (ADR-293 Accepted, code review GO 91); the ring colours are seen on a phone at the T-806 check.

## Q-259 — Split T-405 into a core part and a screens part? (2026-10-27, T-405 plan)
Recommended (ADR-294): T-405 builds the streak records, the event bonus, the daily milestones and the doors (core);
T-405b builds the app lines, the dashboard Streak panel and the strings (standard, cheaper model). Agree, or one task?
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-294 accepted; plan review 86 folded, code review GO 93).

## Q-260 — How event streak days and closed days work (2026-10-27, T-405 plan)
Recommended (ADR-295): the organizer marks closed weekdays (for example Friday) and closed dates; those days neither
count nor break the streak; played days are recorded on every multi-day event so the streak can be switched on mid-event;
a day that has started can no longer be marked closed or open. Agree, or should closed days come from something else
(for example days with no quest open)? Two consequences (plan review): a day lost to an outage cannot be marked closed
afterwards, and a single-day event extended to several days counts from the extension only.
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-295 accepted; plan review 86 folded, code review GO 93).

## Q-261 — The event streak bonus (2026-10-27, T-405 plan)
Recommended (ADR-296): the same bonus every streak day, from day 2 (day 1 is not a streak yet), paid with the day's first
quest. Agree, or pay from day 1, or grow the bonus with the streak (for example bonus × days, capped)?
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-296 accepted; plan review 86 folded, code review GO 93).

## Q-262 — The Questify day and what keeps the daily streak (2026-10-27, T-405 plan)
Recommended (ADR-297): one day for everyone, 04:00 to 04:00 Riyadh time; any event quest completion keeps it (the daily
challenge and word join with T-406); days while the platform switch is off never count. Agree, or should the day change
at midnight, or in the player's own time zone?
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-297 accepted; plan review 86 folded, code review GO 93).

## Q-263 — Daily streak rewards, and gems from a level it causes (2026-10-27, T-405 plan)
Recommended (ADR-298): XP only at 3, 7, 14, 30, 60, 100, 200 and 365 days (50 to 750 XP), each once ever; no items yet.
If streak XP crosses a level, that level pays its usual gems: the streak itself never pays gems (FR-421). Agree, or
should each new streak run pay its milestones again, should items be added, or should streak XP never trigger level
gems?
**Developer view (plan review, 2026-10-27):** agreed that level gems come from the level, so FR-421's "gems unchanged"
means the streak reward itself writes no gems; the milestone and item parts stay open for Dhia.
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-298 accepted; plan review 86 folded, code review GO 93).

## Q-264 — Where the streak switches live (2026-10-27, T-405 plan)
Recommended (ADR-299): the platform daily-streak switch is a feature key T-703's console page flips; the event streak
(on/off, bonus, closed days) is set only by the event owner in its own panel. Agree, or should editors also set it?
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-299 accepted; plan review 86 folded, code review GO 93).

## Q-265 — Streak copy and pressure (2026-10-27, T-405 plan)
Recommended (ADR-300): no freeze or repair, no "don't lose your streak" copy, no countdown or red badge; a broken
streak says "Start a new streak today". Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-300 accepted; plan review 86 folded, code review GO 93).

## Q-266 — Which day a reviewed or team-awarded completion counts for (2026-10-27, T-405 plan review)
Recommended (ADR-301, developer decision for v1): a submission counts on the day a reviewer approves it, and a team's
manual quest award counts the day and pays that day's streak bonus like any completion. Agree, or should a submission
count on the day it was sent (which would need a later day row and a bonus paid after the fact)?
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-301 accepted; plan review 86 folded, code review GO 93).

## Q-267 — T-405 build choices (2026-10-27, T-405 build)
Recommended (ADR-302): the streak bonus always moves the balance with the score (it is paid only while the event is
live, when the shop is open); the daily streak read says whether today counts and the next unpaid milestone; saving the
same streak settings again changes nothing and writes no audit row; the milestone table is append-only; the team's award
list shows a removed streak bonus under the paying quest's title. Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-302 accepted; plan review 86 folded, code review GO 93).

## Q-268 — The streak's cost at the entrance burst (2026-10-27, T-405 build)
Recommended (ADR-303): accept that 300 first-of-the-day completions at once are about 10 to 18 ms slower at p95 (12% to
24%) with the event streak, its bonus and the daily streak, against the plan's 10% target, as the first-N bonus's +22.7%
was (Q-229). Agree, or should the daily streak's row move out of the completion transaction (into the sync, losing a
day played by someone who never opens the app before the day ends)?
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as a burst budget of about 20 ms at p95 within NFR-002's 1 s, in place of the 10% target (ADR-303 accepted). The CTO's rerun at the code review: 75.7 ms without streak work, 89.1 ms with it (+17.7%, about 13 ms), 84.2 ms with the day rows alone (+11.3%); the day's first completion only. Re-timed when T-406 writes the same daily row.

## Q-269 — T-405b copy and layout (2026-10-27, T-405b build)
Recommended (ADR-304): the Home card says "N days in a row" (not "Day N"), reads a closed day first, shows the redone
flame, the scan celebration gets its own streak beat, every other answer carries a "Streak day N! +P" line, the profile's
daily streak sits beside the gems with the next reward, and one toast shows per milestone paid. Agree, or should the
card say "Day N" as the plan's wording did?
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-304 accepted; code review GO 91). The streak bonus lines use the event's quest word in Arabic as in English.

## Q-270 — The dashboard's Day streak panel (2026-10-27, T-405b build)
Recommended (ADR-305): one Save for the five settings, upcoming dates only, started dates listed and fixed, a single-day
event explains itself, and the owner-only note shows for editors on every event. Agree, or should the single-day event
hide the panel and the note?
**Answered (developer, delegated by Dhia, 2026-10-27):** as recommended (ADR-305 accepted; code review GO 91). The weekday chips start on Sunday, the Saudi week.

## Q-271 — The function limits in docs/rules.md are not enforced (2026-10-27, T-405b review)
`docs/rules.md` caps functions at 100 lines and complexity 8, but no lint rule checks it: the T-405b review found a
170-line `StreakPanel`, and oxlint with those two rules reports 326 offending functions outside tests (364 over
complexity, 393 over length, tests included). Turning the rules on at once would fail every build.
**Answered (developer, delegated by Dhia, 2026-10-27):** a ratchet (T-023): a committed baseline that may only shrink,
so new code meets the rule now and existing offenders are split when their files are next touched.

## Q-272 — Split T-406 into a core part and two screen parts? (2026-10-27, T-406 plan)
Recommended (ADR-306): T-406 builds the banks, schedule, cadence, plays, XP and doors (core); T-406b builds the app
screens; T-406c builds the console pages (both standard). Agree, or one screens task?
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes: the split as recommended (ADR-306).

## Q-273 — Daily content periods and the cadence (2026-10-27, T-406 plan)
Recommended (ADR-307): weekly periods run Sunday to Saturday on the Questify day (04:00 Riyadh); the challenge and the
word each have their own cadence, weekly at launch, and a change starts the next day. Agree, or one cadence for both?
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes: Sunday weeks on the Questify day, a cadence per kind, a change from the next day (ADR-307). The row locks, not the freeze trigger, keep a period consistent.

## Q-274 — Question and word content rules (2026-10-27, T-406 plan)
Recommended (ADR-308): each question in both languages with 2 to 4 options; three a period; a question or daily word is
never reused; started content is frozen; the console warns under 7 days or 2 periods of questions, and under 2 periods
of words per language. Agree, or allow reusing old questions after some time?
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes: no reuse, frozen once started, the coverage warnings as recommended (ADR-308).

## Q-275 — Daily XP amounts and what keeps the streak (2026-10-27, T-406 plan)
Recommended (ADR-309): challenge 20 XP for finishing plus 10 per right answer (up to 50); word 50 XP when solved, none
when not (a quest pays 100); never points or gems; finishing either game keeps the daily streak, even a word not solved.
Agree, or pay more under the weekly cadence, or count only a solved word for the streak?
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes: the XP amounts as recommended, never points or gems; a finished play keeps the streak (ADR-309).

## Q-276 — The daily word's rules (2026-10-27, T-406 plan)
Recommended (ADR-310): five letters in both languages; Arabic folds أ إ آ ٱ to ا and ignores diacritics, while ة, ى, ء, ؤ
and ئ are their own keys; only list words count as tries; one game a period in one language. Agree, or also fold ة with
ه and ى with ي?
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes: the folding as recommended; ة and ى stay their own keys (ADR-310).

## Q-277 — What a sponsored daily challenge shows (2026-10-27, T-406 plan)
Recommended (ADR-311): only the sponsor's name, "Presented by" / "برعاية", on that period's challenge; no logo until a
Questify bucket exists (Q-149), no link, no tracking, no data to the sponsor, questions written by the Questify team and
no prizes. Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes: the disclosed name only (ADR-311), in line with Dhia's Q-279 answer; the wording itself stays open in Q-280.

## Q-278 — Switches for the daily games (2026-10-27, T-406 plan)
Recommended (ADR-312): platform switches `dailyChallenge` and `dailyWord`, on by default, apart from `dailyStreak`.
Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes: `dailyChallenge` and `dailyWord`, on by default (ADR-312).

## Q-279 — For Dhia (product): the commercial terms of a sponsored daily challenge (2026-10-27, T-406 plan)
The build only lets the team put a sponsor's name on a period's challenge (ADR-311). Still to decide, outside the code:
the price and what the sponsor receives (the label only, or also a count of players who finished that period's
challenge, which the console shows); who sells it and how it is invoiced (outside the platform, ADR-076); which sponsor
categories are not allowed (for example tobacco, gambling-like or adult brands, with the 13+ audience); and whether a
sponsor may ever fund a prize for the daily challenge. A prize would make it a commercial competition (Ministry of
Commerce licence, contest rules in the app, STORE_COMPLIANCE 1.12) and is not built. Nothing built waits on this.
**Answered (Dhia, 2026-10-27):** "Name only": a sponsor gets the disclosed name on the challenge, nothing more (no logo,
link, data or prize) for v1; revisit after the first real sponsor. Price and invoicing stay outside the app.

## Q-280 — For Dhia and counsel (legal): the disclosure wording for a sponsored challenge (2026-10-27, T-406 plan)
Is "برعاية {name}" / "Presented by {name}" enough disclosure for a paid placement under Saudi advertising rules, or must
it say "إعلان" / "Ad"? Google Play's help says its "Contains ads" label does not cover paid product placement but that
placement must follow local law; sponsored native content would count as an ad. If counsel requires an ad label, the
Play and App Store ad answers (PD-27) need a fresh look before the first sponsored challenge goes live.

## Q-281 — For Dhia (product and legal): where the word lists come from (2026-10-27, T-406 plan)
The daily word needs a list of valid five-letter guesses per language (thousands of English words; an Arabic list is
harder to find) and the daily words themselves. Which source and licence allow commercial use, or does the team build
the Arabic list by hand? The build ships a small test seed only; real lists are imported in the console (T-406c) once
this is settled. (T-406 build, 2026-10-27: no seed ships at all; the tests add their own words, ADR-313. T-406c: the import is built and ships no list, ADR-315.)
**Answered (Dhia, 2026-10-27):** "Open lists + our picks": the guess lists come from free lists whose licence allows commercial use (the developer finds and checks them, then cleans up the Arabic list), and the Questify team hand-picks the daily words (a few hundred, family-friendly). Follow-up task T-406d.

## Q-282 — The T-406 build's small choices (2026-10-27, T-406 build)
Recommended (ADR-313): admin ids on the daily tables without a foreign key (the migration's short lock list); an
unknown challenge id answers `changed` like an unknown word id; the console's refusal names (`retired`, `questions`,
`changed`, `not_period_start`); three questions per challenge checked at commit; coverage counted to 60 periods; no
seeded words or questions; the DB suites' shifted Questify day. And the re-timed entrance burst (ADR-313 item 8): the
streak work stays near the 20 ms budget (+15 and +20 ms), the shared daily streak row adds about 11 ms over the same
load, while 300 extra finishes at the same instant add about 62 ms on a laptop (142 ms p95, inside the 1 s). Read the
budget as the streak's own cost (recommended), or re-time on CranL before launch? Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes, with the review's changes (ADR-313): a unique violation maps by constraint name; only the streak's own cost counts against ADR-303, the shared-row collision is a stress figure and general load sits under NFR-002; the CranL staging load test includes the `daily` kind, and a new writer of `questify_streak_day` re-runs the timing.

## Q-283 — The T-406b screens' small choices (2026-10-27, T-406b build)
Recommended (ADR-314): two cards on the Profile until Questify Home, hidden when a game is null or the read fails and
promising no XP amount before a finish; a reveal after every answer that waits for Next; the grid and keyboard in the
word's language; marks by colour plus a glyph plus a border style, with a legend; a refused guess keeps the letters; a
finish reloads the profile, syncs and shows the level-up card; the next-date line from the phone's clock ("tomorrow" or
a weekday). Agree? Phone check owed: the RTL grid, the Arabic keyboard size on a small phone, VoiceOver and TalkBack
on tiles and options.
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes, as recommended (ADR-314).

## Q-284 — The T-406c console's small choices (2026-10-27, T-406c build)
Recommended (ADR-315): one Content page with a Daily challenge tab and a Word bank tab; a 56-day schedule by period with
started periods read-only; the period control on each tab ("Applies from tomorrow", a same-length request drops the
pending change); stranded content is removed and scheduled again instead of "Move it" (no door moves a row); the
guess list import by paste or text file, in calls of at most 20,000, with the refused lines shown; text marks for
warnings (a "!" on the tab, "Needs attention" on the console home). Agree? Still open for Dhia: Q-281 (where the word
lists come from), because the import is ready and the lists are empty until it is settled.
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes, as recommended (ADR-315).

## Q-285 — T-407 build choices: the split, the consent log, the opt-out link, interests and "For you" (2026-10-27, T-407 plan)
Recommended (ADR-316, ADR-318, ADR-319): T-407 server and web, T-407b the app, T-407c the "set your interests" quest metric
(core); consent as an append-only dated log with a state the log writes, the first answer recorded even when all
channels stay off; one audience door for every promotion; SMS only inside CST's hours; a signed opt-out link with a web
page that asks first; 12 seeded interests, an event holds up to 3, "For you" is a plain match of interests or city,
at most 20. Agree?
**Answered (developer, delegated by Dhia, 2026-10-27):** Yes, as recommended (ADR-316 to ADR-319), with the review's fold-in (a turn-off saves whatever the wording version; the audience re-checks the age; the quest counts interests only).

## Q-286 — For Dhia and counsel (legal): who may be asked for marketing consent (2026-10-27, T-407 plan)
PDPL IR Art. 11 asks consent from a person with full legal capacity, and STORE_COMPLIANCE §3.1 leaves the age "to check with
counsel" (commonly 18). Built around it (ADR-317): a player whose birth year does not prove 18 (this year minus birth
year under 19) is never shown the consent step and cannot turn a channel on; they can turn any off. Counsel to say
whether the age is 18, and whether a guardian's consent will ever be offered for 13 to 17. Changing the age is one number
in `marketing_adult`.

## Q-287 — For Dhia (product): should promotional push and email keep the SMS quiet hours? (2026-10-27, T-407 plan)
The law's 22:00 to 09:00 (01:00 to 12:00 in Ramadan) is for SMS. ADR-065 declined quiet hours for push, so a promotional push
or email can arrive at 03:00. Recommended: keep ADR-065 for event and personal pushes, but hold promotional push and
email to the same window, so a promotion never wakes anyone. Built as SMS only (one line, `CHANNELS_WITH_WINDOW` in
`send-window.ts`).
**Answered (Dhia, 2026-10-27):** SMS only; push and email keep ADR-065 (no quiet hours).
**Answered (Dhia, 2026-10-27):** "SMS only": as built. Only promotional SMS keeps the 22:00 to 09:00 window (01:00 to 12:00 in Ramadan); promotional push and email follow ADR-065 and may arrive at any hour.

## Q-288 — For Dhia and counsel (legal): the consent wording and the promotional sender (2026-10-27, T-407 plan)
The consent text shown per channel (what is sent, who sends it, that it is optional, how to stop) is written in Arabic
and English in `messages.ts` (T-407b) and versioned (`MARKETING_TEXT_VERSION`), and needs counsel's approval before
launch (PDPL Art. 25, IR Art. 29, CST 4.6.6.1, Apple 4.5.4). The promotional SMS sender ("Questify-AD") and its
registration are Q-034; nothing is sent yet, so nothing waits on this.

## Q-289 — For counsel (legal): proof of consent after an account is deleted (2026-10-27, T-407 plan)
Built: deleting an account erases its consent log, state and preferences (the data is personal, FR-127). If counsel says
proof of consent must be kept for a period after deletion (for example against a CST complaint), keep only the channel,
the yes or no, the method, the wording version and the time under the tombstone's id, with no contact, in a new
migration.

## Q-290 — For Dhia (product): the "set your interests" quest's reward (2026-10-27, T-407c plan)
Built (ADR-320): 100 XP and 10 gems, against 300 XP and 25 gems for "Attend 3 events" and "Play in 2 cities", because
choosing interests takes one tap. The XP can be changed in the console at any time (later awards only); the gems are
fixed once the quest is live, so a different gem amount means retiring it and adding a new quest. Say if you want other
amounts before the deploy.
Retiring this quest and adding a new "set your interests" quest pays everyone who already has interests a second time (each quest pays once per player, not the metric); the console warns when a second one is saved beside one not retired.
**Answered (developer, delegated by Dhia, 2026-10-27):** 100 XP and 10 gems, as built (T-407c plan review 92, GO).

## Q-291 — The Questify-wide ranking's shape and the T-408 split (2026-10-27, T-408 plan)
Recommended (ADR-321, ADR-322): split T-408 into the core server (T-408), the app (T-408b) and the console (T-408c); keep
both boards in one `xp_board` table written by `xp_apply` and read them from PostgreSQL, adding a Redis copy only if the
timed read of a player's place on a 100,000-player board passes 50 ms. Developer's call after the plan review.
Build note (2026-10-27): p95 about 37 ms at 100,000 with the index-only fallback, run on its own (ADR-322); the Redis
copy is T-408d, triggered by the RUNBOOK check at about 30,000 ranked players.
**Answered (developer, delegated by Dhia, 2026-10-27):** ADR-321 and ADR-322 accepted as built (T-408 code review 93).

## Q-292 — For Dhia (product): monthly ranking seasons (2026-10-27, T-408 plan)
Recommended (ADR-323): every month is a season on its own, with no button to press. It starts at 04:00 Saudi time on
the 1st (the same edge as the daily games), the monthly ranking starts from zero, lifetime XP and levels stay, and each
past month's top 10 stays visible in the console. No season prizes and no admin-chosen season length in v1. Say if you
want prizes for a season's winners, a different season length, or players to see last month's winners.
**Answered (Dhia, 2026-10-27):** "Automatic monthly". FR-1786 amended; ADR-323.

## Q-293 — Operator invites on the Questify home scanner (2026-10-27, T-408 plan)
Recommended (ADR-324): the center button on Questify home opens event join codes and also operator invites, since staff
are not yet inside the event when they scan theirs. Quest codes say to open the event first. Developer's call after the
plan review. Still open: ADR-324 is decided after the T-408b code review.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-324 Accepted.

## Q-294 — Where the public events and For you sit on Questify Home and Explore (2026-10-27, T-408b build)
Recommended (ADR-325): public events only on Explore (signed-out Home is sign-in and the typed code); Explore order For you, ranking,
public events; Home lists the newest 5 past events then points to the history. Developer's call at the T-408b review.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-325 Accepted.

## Q-295 — The console Ranking seasons page's name and layout (2026-10-27, T-408c build)
Recommended (ADR-326): "Ranking seasons" / «مواسم الترتيب» (not «المواسم», which names campaigns in the console), the months newest
first with one open at a time showing its top 10, read only. Developer's call at the T-408c review.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-326 Accepted.

## Q-296 — The daily word guess lists: sources and a native reader (2026-10-27, T-406d build)
Recommended (ADR-327): English from SCOWL, Arabic from Wikidata Lexemes (CC0), cleaned and filtered as the ADR says, shipped as
two files in `data/word-lists/` for the console import. Two things need a person: an Arabic reader should skim a sample of
`guess-list-ar.txt` (generated verb forms, names filed as nouns) and the Arabic extra block list in
`scripts/build-word-lists.mjs`, and the team imports both files in the console before the first daily word goes live. If the
Arabic list is too loose, the console's remove import prunes it. Developer's call at the T-406d review; nothing waits on it.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-327 Accepted. The Arabic skim stays with a native reader and does not block.

## Q-297 — The guess list import timing and a faster `word_list_change` (2026-10-27, T-406d build)
Recommended (ADR-328): import in calls of 500 words (about 0.7 s each on a laptop, 5 s allowed). Found while checking that the
shipped lists import: `word_list_change` costs about 1.4 ms a word because `word_norm` runs three times per word through
nested functions with their own `search_path`, so the 20,000-word calls T-406c sent would time out. A follow-up could make the
function normalize each input once and inline the normalization (the same word set, 100 times faster); it is core SQL
(migration 0069, still undeployed), so it wants a plan review. Not needed while lists are imported once. The 20,000-word cap
in `0069_daily.sql` and `daily.ts` stays as it is; `docs/API.md` states the real limit of about 3,500 words a call.
Developer's call at the T-406d review.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-328 Accepted. The faster function stays a deferred follow-up (core SQL, needs a plan review); the console import is the fix that ships.

## Q-298 — What "billed on the web" means for invitations (2026-10-27, T-409 plan)
Recommended (ADR-329): the owner requests a campaign in the dashboard, the team agrees the price outside the platform,
and an admin approves it in the console with a message cap; no price or payment appears anywhere in the platform, and
nothing about invitations appears in the app. ADR-076 (accepted by Dhia) already keeps prices and payment off the
platform, so this applies it rather than asking anew. T-409 also splits into the server (core) and the web pages
(T-409b). Developer's call at the T-409 reviews.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-329 Accepted.

## Q-299 — Invitation campaigns: eligible events, criteria and states (2026-10-27, T-409 plan)
Recommended (ADR-330): owner requests; public events only in v1 (developer's decision at the plan review: unlisted and
private left out), joinable by link, ending at least a day later; one open campaign per event; city, up to 3 interests
and history (`none`, `recent`, `own`); the admin's cap is the maximum number of messages; fewer than 50 matching players
means nothing is sent; when the event ends with messages still queued, the rest are skipped and the campaign ends as
sent (`event_over`). Developer's call at the T-409 reviews.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-330 Accepted.

## Q-300 — Invitation channels, frequency, the approved text and message language (2026-10-27, T-409 plan)
Recommended (ADR-331): SMS only in v1 (push with T-501, email with T-706); one message per player per campaign; at most
one invitation per player per week; a short fixed template; the admin approves the exact text (approval fails with
`event_renamed` if the names changed since the preview) and it is frozen; a name rule filters links, phone numbers and
hidden characters, but the admin is the gate; the message in the language of the player's latest consent on that
channel; one consent rule (`promo_pool`) behind `marketing_audience`, now system-only. SMS cannot be approved until the
"-AD" sender is registered (Q-034). Developer's call at the T-409 reviews.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-331 Accepted.

## Q-301 — Invitation results and what they can imply (2026-10-27, T-409 plan)
Recommended (ADR-332): opened through Questify's own link page (token in the fragment, no pixel or SDK), joined matched
on the server, organizer numbers published daily, rounded down to tens with "fewer than 10" below that, at least 50
recipients per send, recipient rows kept 90 days. Because organizers see the send date and each member's join time, a
burst of joins after a send can hint at who was invited on any event; that comes with FR-739. The privacy policy gains
the line in ADR-332 (T-807). Developer's call at the T-409 reviews.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-332 Accepted.

## Q-302 — How invitations are sent (2026-10-27, T-409 plan)
Recommended (ADR-333): the existing in-process tick in rounds of 5 with leases, at most one message per player (an
uncertain send is never repeated, a late answer never rewrites it), one 15-minute hold for the SMS channel when the
account is refused, quiet hours in TypeScript and again in SQL (22:00 to 12:00 in Ramadan), settle running even with the
switch off, no pg-boss yet. Developer's call at the T-409 reviews.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended; ADR-333 Accepted.

## Q-303 — T-409 build: departures from the plan (2026-10-27, T-409 build)
Recommended (ADR-334): the start skips the 24-hour rule; the claim locks campaigns `FOR NO KEY UPDATE`; no foreign keys
on `invitation_recipient` (measured: a 100,000-row fill went from about 12 s to about 4 s) with a trigger for a deleted
campaign; the fill gets its own 60 s statement limit (4.0 s measured on the laptop, the 2 s gate missed there; measure
on CranL before the switch is turned on); `M0030` and `M0090` hold the channel like the other account refusals.
Developer's call at the T-409 code review.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as built at the T-409 code review (89); ADR-334
Accepted, with the review's fold-in and the 90-day purge kept.

## Q-304 — The Invitations pages: the frozen text in the console, Riyadh time, wording (2026-10-27, T-409b build)
Recommended (ADR-335): the console shows the approved (frozen) text after approval, which needs a one-line change to the
reviewed `campaignDetail`; times in Riyadh time; «طلب دعوات» / "invitation request"; the event page links to Invitations
only while the switch is on; the landing page has no language switch and forgets its token after the first read.
Developer's call at the T-409b code review.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended at the T-409b code review (92); ADR-335
Accepted, with the review's fold-in.

## Q-305 — The shop window after the event: where, how long, and changes after the end (2026-10-27, T-410 plan)
Recommended (ADR-336): set on the dashboard's Rewards page as today (0 to 30 days, default 3); it closes exactly at the
end plus those days; before the end any value, after the end only longer while open, frozen once closed (the API and a
database trigger both refuse); the dashboard sends the days only when that field changed. Developer's call at the T-410
reviews.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended at the T-410 plan review (88), with its
fold-in; ADR-336 Accepted.

## Q-306 — Closing the balance: a rule with no write, holds after the close, no archiving yet (2026-10-27, T-410 plan)
Recommended (ADR-337): the balance closes by rule (`shop_state`), with no ledger entry, stored flag or job; codes never
given go to no one, delivered codes stay; holds stay collectible until their own pickup time and their returns land in
the closed balance (FR-1609); rank prizes keep their deadline; score, rank, stamp, souvenirs, XP, level, achievements
and items are untouched, and event-data retention (Q-075) must exclude them. The event stays Ended: archiving at the
close (FR-1608) would block late results, the desk's late handovers and help-desk tickets. Developer's call at the
T-410 reviews.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted at the T-410 plan review (88); ADR-337 Accepted.
Archiving is deferred to **T-411** (added to TASKS): a tick step archives an ended event only when the shop is closed,
no `reserved` redemption of any kind is left, results are revealed or `ends_at` + 60 days has passed, and no help-desk
ticket is open. FR-1608 is marked partly delivered in the SRS.

## Q-307 — What players and organizers see around the close (2026-10-27, T-410 plan)
Recommended (ADR-338): an "open until {date}" banner on Home after the end (no countdown, no loss copy), with a line
when the desk's hours end before the close (items and experiences stop then); once closed the balance reads "Closed"
with the date and the goal card goes; the Rewards tab shows the closing date and what stays; a cancel after the close
warns that returned points cannot be redeemed; the dashboard shows when the shop closes, warns when the desk's hours end
first, and locks the days field as ADR-336 says. Developer's call at the T-410 reviews.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended at the T-410 plan review (88), with its
fold-in; ADR-338 Accepted.

## Q-308 — The recap card's content and sharing (2026-10-27, T-410 plan)
Recommended (ADR-339): event name, date and city, final rank after the reveal, quests done (from the ledger, removals
excluded), up to 3 souvenirs; for members who played, `left` included; no username, score, balance, link or id; shared
as an image made on the phone (`react-native-view-shot`, `expo-sharing`) with no text line, nothing uploaded and no
tracking; both native modules detected before loading, falling back to one text line on an older build. The other
option, a text line only, needs no new dependency but is not a card. Developer's call at the T-410 reviews.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended at the T-410 plan review (88), with its
fold-in; ADR-339 Accepted.

## Q-309 — T-410b build: the screens after the event, the share split, the refusal words (2026-10-27, T-410b build)
Recommended (ADR-340): the recap card and the shop's line on Home for active members once the event ended; the balance
"Closed" and no goal after the close; the Rewards tab swaps its catalog for a closed panel with the cancel note; the
recap card follows the phone's theme and language and names up to 3 souvenirs; the share is a pure sharer plus a native
wiring file with a source-scan guard; the dashboard shows when the shop closes, warns about a desk that ends first, keeps
the days read-only once closed and says each refusal in words. The other option for the card, a fixed poster layout in one
language, needs its own art and a language choice at share time. Developer's call at the T-410b code review.
**Answered (developer, delegated by Dhia, 2026-10-27):** accepted as recommended at the T-410b code review (89); ADR-340
Accepted, with the review's fold-in. The device check stays owed to Dhia (STATE): the restyled card (wood frame, parchment
panel, gold edge) as it looks in the shared image on Android and iOS.

## Q-310 — Archiving ended events: the step, the guards and a final Archived (2026-10-28, T-411 build)
Recommended (ADR-341): the tick's last step archives an ended event when ADR-337 (5)'s four conditions hold, up to 100 a
run, audited like the other moves; insert guards on redemptions and event tickets lock the event against the step and
refuse an archived one with each door's own refusal; an escalated ticket still open blocks archiving; nothing moves an
event out of Archived, for any role. The other options: archive in `advance_event_lifecycle` itself (one function, but
it would run before the reservation timeout and ticket purge of the same run), or restate each door to lock the event
(four large functions restated instead of two small guards). Developer's call at the T-411 code review.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted at the T-411 code review (87, MAJOR folded, no
re-review), with a fifth condition: no event is archived before 30 days after its end, the help desk's sending window
(ADR-248), which also gives organizers 30 days to review pending submissions. No per-event exception block (a known
risk recorded in ADR-341). ADR-341 Accepted.

## Q-311 — How T-501 splits (2026-10-28, T-501 plan)
Recommended (ADR-342): seven slices (store and worker; the APNs and FCM clients; the app; personal pushes; event pushes;
reminders and invitations; the hidden-category hint), with T-312b merged into the app slice and go-live gated by the
RUNBOOK's push checklist on real phones (in T-806's Done-when). The other option, one server slice with the clients
inside, gives one very large core review mixing data rules with outside calls. Developer's call at the T-501 reviews
(plan review 80 folded 2026-10-28; re-review owed).
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted as recommended at the T-501 plan review (80) and
re-review (88, GO), with their fold-ins; ADR-342 Accepted; go-live waits for the RUNBOOK push checklist (T-806).

## Q-312 — The push store's shape (2026-10-28, T-501 plan)
Recommended (ADR-343): a notice per event, a center row per recipient as the record of every message, an outbox per
device, devices tied to the sign-in, kinds as seeded rows, 180-day center retention; producers insert only the notice
and the worker writes every center row and send (plan review finding 2). The other option, event-wide messages read by
union at view time with a per-player read mark, stores fewer rows but makes "every message, read and unread" and
membership at the time of sending harder to prove. Developer's call at the T-501 reviews.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted as recommended at the T-501 plan review (80) and
re-review (88, GO), with their fold-ins; ADR-343 Accepted, with settle also removing the personal notices and center rows a racing producer wrote for a player deleted in the last 24 hours.

## Q-313 — Direct APNs and FCM, and running without keys (2026-10-28, T-501 plan)
Recommended (ADR-344): direct clients on Node's own HTTP/2, fetch and crypto; all-or-none configuration; start and send
nothing when no keys are set (until Dhia's Apple and Google accounts exist); the APNs environment read on the phone, not
from the build profile (plan review finding 5). The other options: a library per provider (more dependencies), or
refuse to start without keys (production could not run before the accounts exist). Developer's call at the T-501b
review.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted as recommended at the T-501 plan review (80) and
re-review (88, GO), with their fold-ins; ADR-344 Accepted, with the re-review's environment rule: `development` → sandbox; `production`, `null` (every App Store and TestFlight install) or an error → production.

## Q-314 — The push worker and its retry rule (2026-10-28, T-501 plan)
Recommended (ADR-345): the in-process loop with its own small pool and leases (no pg-boss), priority and a per-notice
cap, waves acked as they end, no attempt that could outlive its lease, a requeue after a definite 5xx, `unknown` only
after a write, a breaker, holds per APNs environment, and a guard that counts only ambiguous token answers (plan review
findings 3 and 4). The other options: pg-boss (a second job store and a dependency), or T-409's strict "never retry"
(an outage would lose every queued push). Developer's call at the T-501 reviews.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted as recommended at the T-501 plan review (80) and
re-review (88, GO), with their fold-ins; ADR-345 Accepted, with the re-review's fold-in: in-lease tries capped at `8 − attempts`, a per-notice `LATERAL` claim, the deadline on the worker's monotonic clock, and the APNs never-processed answers requeued.

## Q-315 — What a push may say (2026-10-28, T-501 plan)
Recommended (ADR-346): fixed gender-neutral templates per kind, only public names (event, quest, category, reward) and
dates, the name rule with a nameless fallback, ids only in the payload. The other option, generic texts with no names
at all, is safer still but makes every push read the same ("Something happened in your event"). Developer's call at the
T-501 reviews; counsel's data-transfer list (Q-043) already names push text.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted as recommended at the T-501 plan review (80) and
re-review (88, GO), with their fold-ins; ADR-346 Accepted.

## Q-316 — Who receives, what it may name, topics and mute (2026-10-28, T-501 plan)
Recommended (ADR-347): active players and active members only (per-kind exceptions for the join decision and help-desk
answers); rehearsal enrollments only while the event is draft or scheduled, every active member once live or ended,
no one once archived (plan review finding 1); no row naming a quest or category the member cannot see (finding 7); four
topics owned by the kind; mute stops the push but keeps the center row unread; mutes per player across events; no quiet
hours or brake (Q-287). The other option for mute, hiding muted messages from the center, conflicts with "the center
holds every message". Developer's call at the T-501 reviews; the topic list itself is FR-1115's.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted as recommended at the T-501 plan review (80) and
re-review (88, GO), with their fold-ins; ADR-347 Accepted, with event notices naming a quest checked by `member_event_quests`' visibility test and a named reward by its audience.

## Q-317 — Promotional push and the invitation channel order (2026-10-28, T-501 plan)
Recommended (ADR-348): consent from `promo_pool('push')` at fan-out and claim; a promotional tap opens its center row,
which holds the opt-out; invitations by push first when possible, else SMS, one message per player per campaign. The
other option, SMS first, costs money per message for players who also accepted push. Developer's call at the T-501f
review.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted as recommended at the T-501 plan review (80) and
re-review (88, GO), with their fold-ins; ADR-348 Accepted.

## Q-318 — The app's permission moment, environment, center route and taps (2026-10-28, T-501 plan)
Recommended (ADR-349): the explainer after a join, Not now waits 30 days, the APNs environment from `expo-application`,
the center at `/notifications` with the offers screen moved to `/settings/notifications`, a fixed route table for taps,
private lock-screen channels for personal and offers, `expo-notifications` and `expo-application` as new dependencies.
The other option, asking once and never again after Not now, loses players who joined before they cared. Developer's
call at the T-501c review.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted as recommended at the T-501 plan review (80) and
re-review (88, GO), with their fold-ins; ADR-349 Accepted, with the environment rule of Q-313 and the `enrollment` trigger's filter (`declined → active` in, operators and rehearsal accounts out).

## Q-319 — Where the T-501 build fills in the push plan (2026-10-28, T-501 build)
Recommended (ADR-350): the quest visibility test is `member_event_quests`' listing rule plus the open window; Android
tokens up to 2,048 characters (an index limit); a new APNs environment counts as a new token; `requeue` says whether
the request was written and every attempt is raced against its 10 s limit; ambiguous token answers wait for the round's
end; the provider settings and their startup check stay with T-501b's clients, T-501 logging `push.provider_missing`;
`notice_create` refuses every mismatch by inserting nothing; the per-member rules in PL/pgSQL for speed; the center in
the request's language. The other options: follow the plan's literal wording (an index that refuses long tokens at
insert, a quest test that disagrees with the quests list for unopened quests, a 3.5 s fan-out call), or build the
provider settings now with no client to use them. Developer's call at the T-501 code review.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted at the T-501 code review (87, BLOCKER and MAJOR fixed,
narrow re-review owed), with its fold-ins: no promotional center row without push consent, the claim's scan stopped at
200 notices per target, a token version on each send, a failing notice backed off (1, 4, 16 minutes, then hourly), the provider's
deadline 500 ms early. ADR-350 Accepted.

## Q-320 — Where the T-501b build fills in the provider clients (2026-10-28, T-501b build)
Recommended (ADR-351): one HTTP/2 transport for APNs and FCM (only a stream's state tells "never written" from "written,
then lost"); never-processed answers requeued uncounted on a new connection; a 4-minute idle close; every status mapped
(any 410 removes, any 403 holds, other 4xx `failed` and logged); no FCM `collapse_key` (Google ignores it for
notification messages); Google's token endpoint failing to answer requeues while only a refusal holds; strict settings
kept as key objects, from the environment only; one APNs key enabled for both environments. The other options: `fetch`
for FCM as ADR-344 said (a connection failure and a lost request look the same, so one of them is misfiled), holding
FCM on any token failure at start (a passing network blip stops Android pushes for 15 minutes), or separate APNs keys
per environment (four more settings for a case the RUNBOOK avoids). Developer's call at the T-501b code review.
Note (code review): the in-lease 5xx retries after 1 s and 2 s (ADR-345) go against Apple's advice to retry a 5xx after
15 minutes with back-off; they are bounded only by the breaker and the 8-attempt limit. Revisit if Apple's metrics show
throttling.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted at the T-501b code review (88; the MAJOR fixed: a lost
stream replaces the connection; `close()` no longer waits on a dead peer; the FCM 429 hold capped at 15 minutes; the
ADR's Apple quote corrected; the go-live checklist completed). The reviewer accepted every departure, FCM over HTTP/2
included. ADR-351 Accepted.

## Q-321 — Where the T-501c build fills in the app's push (2026-10-28, T-501c build)
Recommended (ADR-352): the push explainer on the join result screens (not Event Home, which shows the location sheet);
the route table naming the owed-push kinds now, guarded by a test; a tap's fields read from `trigger.payload.q`,
`remoteMessage.data` and `content.data`; one native-access file with every package loaded only after its native modules
are found; "Mark all as read" on the center; a small unread read per foreground for the bell; the offers screen moved to
`/settings/notifications` under the push status and topics. The other options: the explainer on Event Home after the
location sheet (two sheets in sequence, more state), no kind names until the slices exist (the center's taps untestable),
reading `content.data` only (misses a direct-APNs payload), loading `expo-notifications` directly (crashes an older
development build at launch). Developer's call at the T-501c review.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted at the T-501c code review (84; MAJOR 1 and 2 fixed: a
cold-start tap waits for the launch screen to leave, and the bell refreshes from a one-row center read, never the
profile; the minors folded: a held tap dropped on sign-out, the registration record bound to the player and ignored when
its sign-in ended meanwhile, the Android explainer skipped without a Firebase file and the file made a store gate, the
"always reach you" line naming decisions, answers and prizes, the center keeping older pages on focus, the comment on
the module check, a sign-out wait of 3 seconds). ADR-352 Accepted.
Open for Dhia (not blocking): the notification icon (96 px white-on-transparent from the brand deck) and the Firebase
`google-services.json` and how it reaches the build (RUNBOOK, "The app's side of push").

## Q-322 — Where the T-501d build fills in the personal pushes (2026-10-28, T-501d build)
Recommended (ADR-353): the join-decision trigger leaves out the player's own invited re-join; `reward_ready` once per
reservation at the first desk opening it waited for; `reward_ending` 15 minutes before the end of a hold longer than 30
minutes counted from when it became collectable, only while the desk can still be reached; one `push_due()` door every
minute from the worker; the help-desk answer as three kinds on one route; `notice_create` in PL/pgSQL (its plan kept)
and `push_names` inlined; the prize naming its deadline's date and time; rehearsal accounts getting their own answers
and decisions on submissions. The other options: a ready push at every desk opening (noise for a long rank-prize hold),
the ending push for every hold (a "held until" a few minutes after a short reservation), the due scans inside settle
(every 10 minutes: too late for a 15-minute warning), one help-desk kind with a variant in the template (a renderer
change for one producer), keeping `notice_create` in SQL (about 2 s more for 5,000 decisions). Developer's call at the
T-501d code review. Also measured: an unbounded accept-all of 5,000 requests took about 5.8 s before T-501d (5 s of
it the souvenir enqueue trigger `souvenir_on_fact`, T-402b) and 7.4 s with the join-decision push, over the API's 5 s
statement limit; recommended: accept-all takes at most 1,000 requests a call and the dashboard repeats.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted at the T-501d code review (84; the flaky assertion
and the accept-all ceiling fixed, the minors folded). **Cap taken now:** accept-all takes at most 1,000 requests a call
(one call 1.76 s on the laptop with the trigger) and the dashboard repeats while one accepted some and requests wait,
at most 10 calls a press. The souvenir trigger's cost stays as it is; measured again on CranL before NFR-004's load
test. ADR-353 Accepted.

## Q-323 — How a hard limit is checked during accept-all (2026-10-28, T-501d cap re-review)
The seat guard `enrollment_player_limit` (0036) counts every enrollment of the event for each row accept-all accepts, so
on a hard-limited event one call's cost grows with the event's size (the review measured one call of 1,000 at 3.3 s
with 5,000 pending, 5.3 s with 12,000 pending and 9.4 s with 20,000 seated; above the API's 5 s limit the call is
refused and accepts nothing). Stop-gap taken (developer's decision, ADR-353 (5)): a hard-limited event accepts 250 a
call and the dashboard repeats. Recommended (Proposed, developer's call, T-221): check the limit once per statement
(an AFTER statement trigger with transition tables over the moved rows, holding the seat lock the doors already take)
so accept-all becomes one call again. The other options: a seat counter on the event kept by every write that seats or
unseats a player (fast, but every join, leave, ban and removal must keep it right); a partial index on seated
enrollments (only lowers the cost per row; the count per row stays); keeping the 250 cap (more calls for big events).

## Q-324 — Where the T-501e build fills in the event pushes (2026-10-28, T-501e build)
Recommended (ADR-354): a live or ended event's notices skip rehearsal accounts; every event push skips an operator kept
from playing; Launch, Send and a boost saved to start now push at once by trigger, scheduled moments by the due scans
every minute; the markers carry the moment (a rehearsal send and the live one are two pushes; a moved start or opening
is pushed again at its new time and the old push is skipped); one community push per goal per settle, for the highest
step reached, naming no quest and opening Event Home; a category's opening pushed only when it opens after the start,
within 2 hours, with a visible quest, to members who can open it. The other options: rehearsal accounts on a live event
keep getting pushes until the wipe (the plan's first table); one push per milestone even when several are passed at once
(a burst); the goal's title in the text (a new placeholder outside the allowlist); boosts only through the scan (up to
a minute late for "start now"); a category push also at the event's start (a second push beside "starts soon").
Also measured (ADR-354 (5)): the shared visibility checks (`sees_category`, `flash_shown`, `member_sees_quest`,
`notice_visible`, `notice_reward_seen`) planned their nested SQL functions again for every member, so a live poll's
fan-out to 50,000 members took 336 s; restated in PL/pgSQL with the same rules it takes 25.7 to 28.6 s, each call of
2,000 about 1.1 s (the T-501 gate is 1 s, the statement limit 5 s). Recommended: accept that. The other option: event
batches of 1,500 (more calls, the same total). Developer's call at the T-501e code review.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted at the T-501e code review (78; the BLOCKER and every
finding folded). **Batch cut to 1,000:** the event fan-out takes 1,000 enrollments a call (a live poll to 50,000 members
30.0 to 30.2 s over 52 calls, median 0.60 s). Also taken: no opening push for a category that unlocks after another (its
gate check was too slow per member); flash quests and boosts wait for their category to open (a boost also for its
community lock) and are pushed once it does; a moved start or opening is pushed again only when moved 15 minutes or
more (an opening only to a later time), at most twice. ADR-354 Accepted (re-review 91 folded).

## Q-325 — Where the T-501f build fills in reminders and promotion by push (2026-10-28, T-501f build)
Recommended (ADR-356): the streak reminder from 18:00 Riyadh, once a day, only to players with a pushable device and
`reminders` not muted, skipped at sending once they played; the shop's closing once per event to members with a
balance, skipped (with no second push) when the window was extended after it; invitations by push or SMS with one fixed
channel per player (push first when opted in on push with a pushable device), handed to the push store by the
invitation tick and counted sent then; the open counted from the center row by id, never by "mark all"; a promotional
tap opens the center on its row with the opt-out, and an invitation row carries "See the event". The other options: a
reminder center row for every streaking player (a row a day for players who cannot be pushed); a second shop push at the
new close; an SMS fallback when a push row's consent or device is lost (a second channel for one player); the
recipient row `sent` only after the push provider answered (couples the two senders); a separate detail screen for a
promotion. Developer's call at the T-501f code review.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted at the T-501f tier A code review (MAJOR fixed: push
is offered only when both providers are set up, and the hand-off waits for the platform push switch as well, so no row is
marked `sent` when no push can go out; the minors folded: the open locks its campaigns in id order first, the claim asks
`invitation_event_ok` again for an invitation, the hand-off is a tick step of its own). ADR-356 Accepted.

## Q-326 — Where the T-501g build fills in the hidden-category hint push (2026-10-28, T-501g build)
Recommended (ADR-357): the reveal is written by the fan-out with the center row (so it needs no device, permission or
delivery, and the producer calls only `notice_create`); recipients are active real members who joined at or before the
press, are in the category's audience and were not told by an earlier hint since they joined; the text names the event
only, never the category; one notice per Idempotency-Key and a second press while the first is delivered is refused; a
later press reaches only members not yet told; the count behind the confirmation is one set-based statement that a test
holds equal to the recipients. The other options: reveal in the door at press time (a 50,000-row insert in one
statement, and a reveal with no push when the kind is broken); naming the category in the push; telling every member
again on a second press; a count that is an upper bound for targeted categories; sending nothing to members who already
found the category by its code. Developer's call at the T-501g code review.
**Answered (developer, delegated by Dhia, 2026-10-28):** accepted at the T-501g tier B code review (MAJOR fixed: the
count states the exclusion list as an inline anti-join, no longer 16 times slower once an event has one entry; minors
folded: a press that would tell no one is refused `409 hint_nobody`, and the since-joined cut-off, the 10-minute pending
cut-off and the go-live wipe each have a test that fails when the protection is removed). ADR-357 Accepted.

## Q-327 — T-502 announcement limits and Home presentation (2026-10-29)

**Status:** Resolved (developer, delegated by Dhia, 2026-10-29). **ADR:** ADR-358 Accepted.
Recommended: the approved plan's 60/500/140-code-point text bounds, shared name-rule filter, 3/hour and 10/day rolling
reservations, 2-minute to 180-day scheduling and 30-minute lateness cutoff. Organizer text is the explicit filtered
exception to fixed push templates; never email or SMS. The new Home strip is flash/boost only, from Quests, with
existing poll/community cards beside it; categories stay Quests, sessions T-505. Alternatives: unrestricted free text
or more sends (spam/privacy risk), fixed templates only (cannot carry an announcement), duplicating all existing Home
cards in a strip, or changing the live feed's 15-minute tail (unnecessary scope). No external credential blocks local
T-502. Coordinator accepts these defaults, including flash/boost-only strip composition, after independent review
and both MAJOR fixes (efad9cd). Pending schedules are paginated earliest first, separately from bounded history;
send and lifecycle writes are serialized by the event row lock. APNs/Firebase/device go-live gates remain unchanged.

## Q-328 — T-503 ranking transition semantics (2026-10-29)

**Status:** Resolved design (developer, delegated by Dhia, 2026-10-29); implementation proof gates tracked in plan.
**ADR:** ADR-359 Accepted design.
Recommend ordered transaction-level durable crossing facts, eligible-only indexed projection, source-time lifecycle
reset generations and exact latest transition identity checks at fan-out AND claim. Remove overall Redis authority:
board/own/total and afterCompletion place use a coherent PostgreSQL publication boundary; today stays unchanged.
This preserves FR-613's visible 11->9->11 crossings between ticks. Coalescing/product relaxation is rejected.
Coordinator must inspect full publication/source writer G/E lock matrix, membership/contact/default-setting source
coverage, DB-only own-rank cost and hot-event <3 ms mean serialized lock hold feasibility before permitting build.
Alternative distributed cache-publication protocol is more invasive; reverting to dirty final-state detection is not
valid. MAJOR-only corrections need no independent re-review (ADR-355), but are not accepted by their author.
Coordinator inspected and accepts this design; local implementation is authorized with the early performance-first
gate. No throughput feasibility is claimed before measurement. No Dhia question. Resolution map/proof:
`plans/2026-10-29-t-503-rank-organizer-alerts.md`.

## Q-329 — T-503 organizer switches, thresholds and email boundary (2026-10-29)

**Status:** Resolved design (developer, delegated by Dhia, 2026-10-29); implementation proof gates tracked in plan.
**ADR:** ADR-360 Accepted design.
Retain seven own-member preference defaults ON and operational transport default OFF. Capture recipients at source;
final staff/membership generation/scope/opt-out reauth, fenced dispatch_started before token/send network, no
uncertain retry/failover. Explicit writer/lock matrix and two-connection BOTH-order barriers replace vague guards.
Recommend per-waiter google-token.ts cancellation without cancelling unrelated auth refresh callers; structured
provider-specific proven refusal vs uncertain classification, never EmailSendError message parsing or timeout retry;
auth failover unchanged. Stock/code total/threshold revisions do not reset a low episode; recovery rearms, genuine
cap revisions remain separate. Numeric revision tests and exhaustive existing source inventory are in the plan.
T-503 owns infrastructure/UI; no T-609 duplicate infrastructure or T-701 invented producer. Remaining coordinator
technical decisions: complete source guard coverage, conservative provider refusal proof/allowlist and rank cost
trade-off in Q-328. No task tick/build acceptance. Live mail still requires Saudi transport or explicit counsel-approved
foreign-transfer extension (Q-083/T-807); auth exception insufficient. No credentials/services requested.
Coordinator accepts these defaults with an empty automatic send-retry allowlist until provider nonacceptance proof;
local fake implementation may follow the early rank feasibility gate. Transport authorization is not implied.
Full review80 resolution map: `plans/2026-10-29-t-503-rank-organizer-alerts.md`.

## Q-330 - T-503 failed early full-source event-lock budget (2026-10-29)

**Status:** Closed 2026-10-29 by ADR-362 (periodic top-ten diff; Q-331). Earlier text kept as history:
coordinator had authorized test-only profiling, not a replacement protocol.
**Evidence/recommendation:** Proposed ADR-361 and `evidence/2026-10-29-t503-early-gate.md`/JSON.
Two actual-source 50,000-member runs give mean E hold LOWER bounds 14.46488 / 14.20142 ms
against required <3 ms (target <=1.5 ms); confirmation full mean is in [14.20142, 20.262509] ms.
Preserve FR-613 ordered crossings, coherent DB publication and NFR-003. Recommend profiling/reducing
the full source chain or explicitly accepting a newly proved terminal publication fence after business
locks, never merely moving E into a late nested payer where it can invert existing source locks.
No coalescing or requirement waiver. Implementation stopped; unchanged production migrations/adapters.
Source resets/defaults, complete writer/cascade inventory, both-order barriers, excluded-leader/own/total
equivalence, steady load/queue/propagation and all email/UI/code-review gates remain unfinished.
Coordinator chooses the technical next action; worker does not self-approve or request another review.

## Q-331 - T-503 reset to a periodic top-ten diff (2026-10-29)

Should top-ten pushes stay exact per transaction (ADR-359), or come from a periodic diff that may drop a blip
reversing within seconds? **Answered (developer, delegated by Dhia, 2026-10-29):** periodic diff; ADR-362 Accepted.
Q-330 closes with it.

## Q-332 - T-503 build choices: PostgreSQL top-ten read, alert sources and the OFF transport (2026-10-29)

Should the rank diff read the Redis board (needing a reader) or PostgreSQL, which alert sources does T-503 wire, and what does
the worker do with queued rows while the mail transport is off? **Recommended (developer, T-503 build):** PostgreSQL in the
board's own order and rule; five of the seven sources (all but `content_unpublished`, owed to T-701/T-609); queued rows skipped
as `transport_off`, nothing leaves the machine. **Answered (developer, delegated by Dhia, 2026-10-30):** accepted as recommended; ADR-363 Accepted.

## Q-333 - T-504 big screen: default scenes, fixed rotation, polling and the photo wall (2026-10-30)

Which scenes does an unconfigured big screen show, how long does a scene stay up, and does the screen need a server-sent
stream? **Recommended (developer, T-504 build):** all three scenes in order until the team picks; 15 seconds a scene, fixed; polling
every 3 seconds, no stream; the photo wall (FR-635 to FR-637) split to T-504b until T-301b has its bucket. **Open:** Dhia may want
a per-event rotation time, a different default, or a today's-ranking scene (T-216); each is a small addition. ADR-365 Proposed. **Answered (developer, delegated by Dhia, 2026-10-30):** accepted as recommended; ADR-365 Accepted. The TV shows `after_vote` poll results live to the room while a phone waits for its own vote (FR-634, counts only); say so in the poll builder help (FOLLOWUPS).

## Q-334 - T-599 dashboard menu groups and phone menu (2026-10-30)

How should the dashboard list an event's 18 pages, and where does navigation live on a phone? **Recommended (developer,
T-599 build):** a column on the start side on a desktop, grouped This event / Set up / During the event / Review; on a
phone a Menu sheet with the same list and the account links. **Open:** Dhia may prefer other group names or order, the
event's name at the top of the menu, or a bottom tab bar on a phone. ADR-366 Proposed. **Answered (developer, delegated by
Dhia, 2026-10-30; T-599 review):** accepted as recommended, with the one-link "This event" group merged into the organizer's
group as "Event overview", tighter desktop rows, a native modal dialog and an inert page behind the phone menu; ADR-366 Accepted.

## Q-335 - T-599b page width, one box level and contrast (2026-10-30)

How wide should a dashboard page be, and how are boxes nested? **Recommended (developer, T-599b build):** the content area's width
from the start edge up to 70rem, one box level (a card or section inside another is drawn plain), and WCAG AA contrast for every
state of every control, checked by the layout spec. **Open:** Dhia may want a different maximum width, or sections inside sections
kept framed. ADR-367 accepted (developer, 2026-10-30, T-599b review 91 GO).

## Q-336 - T-599c photos, logo, icons and smooth navigation (2026-10-30)

Which pictures were broken, and is an English wordmark fine on the Arabic pages? **Recommended (developer, T-599c build):** no picture on
a dashboard, console or public page failed to load (all 12 of them load, locally and on staging); the missing tab icon was the only image
request that failed, and it is fixed with the brand's app icon; the English wordmark in the top bar on every page; icons drawn in one
inline set; the shell in layouts. **Open:** Dhia may know a page whose picture was wrong (name it and it is added to the layout check), may
want an Arabic wordmark, or a different icon style; the event link's share image names `questify.sa`, which is not live (ADR-113).
**Dhia (2026-10-30):** the broken pictures were in the currency icon picker ("maybe it's working now"); all five `/currency` pictures
answer 200 on staging after the T-599 deploy, so the photos part is closed. Still open: an Arabic wordmark, the icon style, the share image address.
ADR-368 Proposed.

## Q-337 - T-307b live finale: owner only, the screen stays open after the end, the reveal stays on the Results page (2026-10-30)

Who sets the finale, how does it take the screen, and where are the winners revealed? **Recommended (developer, T-307b build):** only the
owner sets or clears it (as the reveal is the owner's); a set finale joins the screen's scenes and takes the whole screen from its time on,
and the screen stays open after the event ends while one is set (the device's own 24 hours bound it); the winners show only after the
owner's existing Confirm and Reveal on the Prizes and results page, with no score (FR-255); Q-127 stays as it is, so a finale before the
end needs the event's end time moved. **Open:** Dhia may want editors to set the finale, a Reveal button on the Big screen page itself, or
confirming while the event is live (Q-127); each is a small addition. The phone's celebration shows on the next Home read, not live, until
T-501's reveal push. **Decided (developer, delegated by Dhia, 2026-10-30):** as recommended, ADR-369 accepted after the T-307b
review (93 GO); the open items wait for Dhia to ask.

## Q-338 - T-599d what stays as a help line, and how an editor sees owner-only switches (2026-10-30)

Which lines survive ADR-370, and how does an editor see a switch only the owner can change? **Recommended (developer, T-599d build):** keep, as short
lines, only what changes what the user does and the label cannot carry (a rule to meet, an irreversible warning, a price, a locked, empty or
failed state, a count), listed in `apps/web/src/lib/help-copy.test.ts`; move real explanations to info buttons; show an editor's switches
disabled and switched as they are, with no per-switch note; sign out is icon-only everywhere, the app keeps its confirmation. **Open:** Dhia may
want a line back, a spoken reason for a disabled switch, or the sign-out word back in the phone menu. **Decided (developer):** as recommended,
ADR-371 accepted (developer, 2026-10-30, T-599d review 91 GO).

## Q-339 - CI cost: which pushes run which browser specs (2026-10-30)

How should the browser suite (16 minutes, one worker) run so a push does not pay for all of it? **Recommended (developer):** the layout check plus
the specs of the changed area on each push, chosen by `scripts/ci-scope.mjs`; the whole suite when shared code changed, and once a day plus by
hand in `full.yml`; the security floor unchanged on every push (ADR-372). **Open:** Dhia may prefer two shards (needs the API's per-admin limits to
allow two workers), a weekly full run instead of daily if the repository turns private (about 900 minutes a month), or the whole suite on every
push again. **Decided (developer):** as recommended, ADR-372 accepted (2026-10-30).

## Q-340 - T-505 agenda and sessions: what is decided without Dhia (2026-10-30)

**Recommended (developer):** registration is free and records the player, the session and the time only; an overlap is a warning the player can confirm, not a block; a registration-required session without walk-ins refuses a player who did not register, with walk-ins on it records them as walk-ins; a full or closed session simply offers no button; the agenda link on Event Home is always shown; the session's points on check-in wait for T-505b (tier A). **Open:** whether an event with no sessions should hide the Home link (needs a count on Home), whether waitlists matter for full sessions, and how many points a session should give (the organizer sets it in T-505b). **Decided (developer):** as recommended, ADR-373 accepted after the T-505 review (93 GO, 2026-10-30).


## Q-341 - T-506 maps: what is decided without Dhia (2026-10-30)

**Recommended (developer):** maps ship as plain named boards until a storage bucket exists (Q-149), with pins placed by clicking on the board; the uploaded picture is T-506b; a quest has one pin in an event; a quest pin shows done, open or locked (not live, not yet open and closed read as locked); "you are here" is the last station scan if its quest has a pin, with the time, and nothing otherwise; the List and Map toggle and the Maps link on Home are always shown. **Open:** whether a map with no pictures is useful enough to show players before T-506b (an organizer who adds no map shows players nothing but an empty list), whether "you are here" should fade after a few hours, and whether a quest should be allowed one pin per map (floors). **Decided (developer, delegated by Dhia, 2026-10-30):** as recommended, ADR-374 accepted after the T-506 review (93 GO).


## Q-342 - T-507 sponsors: what is decided without Dhia (2026-10-30)

**Recommended (developer):** sponsors ship without logos or banners until a storage bucket exists (Q-149), with a lettered mark in the logo's place; an item has one sponsor and tagging it to another moves it; a category tagged to a sponsor counts all its quests as the sponsor's for the strip; tiers are platinum, gold, silver, bronze and partner and order the strip; the strip and the "presented by" label are always shown when a sponsor exists; sponsors are not an add-on key yet; souvenir tags (T-507c) and analytics by sponsor (FR-1306) wait. **Open:** whether sponsors are a paid add-on (BUSINESS_MODEL line 34 lists them, PRICING does not price them; a gated key would hide the page until Questify unlocks it, FR-1729), whether the five tiers fit how Saudi events name them, whether a sponsor needs a short description or a link (ADR-067 says no link and no tracking, so the build has none), and whether "presented by" should also show on a quest inside a tagged category (the category header shows it once). **Decided (developer, delegated by Dhia, 2026-10-30):** as recommended, ADR-375 accepted after the T-507 review (93 GO).


## Q-343 - T-508 quest ratings and survey results: what is decided without Dhia (2026-10-30)

**Recommended (developer):** quest ratings start off for every event and the owner turns them on in the event's switches; the prompt is a thumb up or down with Skip under a quest the player completed, a skip is remembered, and a thumb can be changed; the quest's row shows "80% liked (8 up, 2 down)"; survey results show on the quest's form and on the agenda row of a session that links the survey, with a spreadsheet export; the speaker reads a survey through a link with no account that the owner or an editor makes, replaces or stops, and the speaker's view leaves out text answers that look like a contact detail; no minimum number of responses. **Open:** whether a speaker's link should expire (it works until stopped or replaced), whether a survey with only a few responses should be held back from the speaker's view (a room of five could identify its answers), whether a quest linked to two sessions should be shareable per session (the responses cannot be split), whether ratings should be on by default for the Questify-made events, and whether the speaker's link should be emailed by Questify (a speaker has no stored email, so the organizer sends it). **Decided (developer, delegated by Dhia, 2026-10-30):** as recommended, ADR-376 accepted after the T-508 review (93 GO, 2026-10-31); the speaker's view hides text answers below 3 responses (review finding).

## Q-344 - T-509 Cheers: what is decided without Dhia (2026-10-31)

**Recommended (developer):** the owner starts a cheers moment (1 to 30 minutes, 5 by default) from the Big screen page; while it is live the app shows five emoji reactions (heart, applause, fire, star, party) and the big screen runs the Cheers scene alone, floating them up with a running count of each; each player may send 30 a minute; the event's Cheers switch (on by default) sits on the same page. **Open:** whether 30 a minute is the right limit for a stadium-sized crowd (it is one constant in the database), whether a moment should interrupt a started finale (it does now), whether the reactions should be Questify's own 3D art instead of the platform's emoji (the brand deck asks for 3D icons; emoji render differently on an old TV), and whether the app should show a live counter. **Decided (developer, delegated by Dhia, 2026-10-31):** as recommended, ADR-377 accepted after the T-509 review (92 GO, 2026-10-31).

## Q-345 - The desktop menu: scroll, not collapse (2026-10-31)

**Recommended (worker):** the desktop navigation column scrolls on its own and brings the open page's link into view; no group collapses. **Open:** whether a person with a short screen should instead get collapsible groups (the open page's group open, the state remembered); it would change every browser spec that clicks a link of the other group. **Decided (developer, delegated by Dhia, 2026-10-31):** as recommended, ADR-378 accepted.

## Q-346 - T-510 default notification topics: what is decided without Dhia (2026-10-31)

**Recommended (developer):** an event can start any of the four topics off for its players (everything starts on); a player who has turned a topic on or muted it keeps that choice, whatever the event says; a player who has not chosen follows the event, and Settings shows the switch off with one line saying an event they joined started it off; the organizer's switches sit on the Announcements page, open to the owner and editors. **Open:** (1) whether a late change by the organizer should also reach players who joined before it (as built: yes, until they choose); (2) whether a player in two events that differ should see the topic per event (as built: one global switch, off while any event starts it off); (3) whether a duplicated event copies its defaults (T-601 will decide). **Decided (developer, delegated by Dhia, 2026-10-31):** as built, ADR-379 accepted after the T-510 review (94 GO).


## Q-347 - T-601 duplicate an event: what is decided without Dhia (2026-10-31)

**Recommended (developer):** an owner or editor duplicates an event from the events list (an icon on its row, a dialog asking for the new name and times, both prefilled from the source with the name marked "(copy)" / "(نسخة)"); the copy is a Draft with the source's setup and none of its people, points, prizes handed over, codes or secrets; every time moves by the distance between the two starts; templates are split to T-601b. **Open:** (1) whether community goals, boosts, the finale, souvenir rules, NFC tags and operators should be copied too (as built: no; each holds state, a frozen promise, a device or a person, and a copy of a tag or an operator would be a second key to the old event); (2) whether the dialog should offer to copy only part of the setup (as built: all of it, and the organizer deletes what they do not want); (3) whether a duplicated event of an ended event should also carry its sponsors, agenda and maps (as built: yes, with moved times). **Decided (developer, delegated by Dhia, 2026-10-31):** as built for all three; the seat limit is not copied either (a billing term Questify sets at activation, T-601 review). ADR-380 accepted.
