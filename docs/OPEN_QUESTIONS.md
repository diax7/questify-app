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
| Q-110 | **Closed 2026-11-02 by T-701 (ADR-406).** Organizer suspension (FR-1607, and the suspend half of FR-1402) moved from T-210 to T-701 (console foundation, which also lists FR-1402). It narrows every player read path (event page, list, quests, home) and `join_event`, which T-212 rewrites at the same time. Claude's recommendation: accept the move; T-701 uses `organizer.status = 'paused'` and the enrollment trigger pattern of ADR-141 | Until T-701, a misbehaving organizer is stopped by hand (support) | 8 |
| Q-111 | Usage figures (FR-1730) and editable support contact (FR-1731) moved from T-210 to T-703 (platform settings): no SMS, push or storage metering exists yet, and the contact page waits on T-706. The emails to the owner on activation, rejection and the 80%/100% marks wait for the alert switches (FR-1727); the dashboard card and banner are the alert now. Claude's recommendation: accept both moves | The owner learns of an activation on the dashboard, not by email, until the alerts task | 8 |
| Q-115 | Retention of join answers and guest lists (T-212, Q-075): a guest list holds contacts of people who may never sign up. Should it be purged a set time after the event ends, and are a player's answers erased when they delete their account (T-217) or only with the event's data? Built: both stay with the event; answers go when the enrollment goes. Claude's recommendation: purge guest lists 30 days after the end, erase answers with the account | PDPL minimization; the deletion flow (T-217) and the retention job need the rule | 8 (counsel) |
| Q-116 | **Closed 2026-11-02 by T-701:** the console's event page, organizer list and organizer page each write one audit row with ids only; the activation queue and the lookup by code show no email and stay unaudited. Console reads are not audited yet (T-210 CTO review): `GET /v1/admin/activation-requests`, `/v1/admin/events?code=` and `/v1/admin/events/{id}` show an owner's email and write no audit row, while SECURITY threat 5 promises every admin read is logged. Claude's recommendation: T-701 (console foundation) adds one audit row per console read, with the rest of the console | Until then a misused admin account's reads leave no trail | 7 |
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
Riyadh? Sharing `b7r-media` is not recommended. **Dhia (2026-11-01): "Later"** (asked with the options a second CranL bucket, Oracle Object Storage, or later). The upload tasks stay parked: T-301b, T-305b, T-504b, T-506b, T-507b, T-602b.

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
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-196 accepted.
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
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-200 accepted.
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
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-212 accepted.
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
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-214 accepted.
ADR-214: memory match and slide puzzle first (T-305), catch and tap rush next (T-305c), organizer images once a
Questify bucket exists (T-305b, blocked on Q-149). Agree?

## Q-181 — How catch and tap rush are checked (2026-10-24, T-305c plan)
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-216 and ADR-217 accepted.
ADR-216 and ADR-217: the two real-time games move on a fixed tick so the server replays them exactly; a tap on a
target in its first 120 ms is ignored by the app (no person reacts that fast); fast but possible play is flagged for
the organizer and still paid; a round pauses while the app is not active, within its result window. Note: catch's
"foreseen" flag only catches a naive seed reader; one that waits 133 ms or more, or is already in position, is never
counted, so the flag is advisory only. Agree?

## Q-182 — Catch and tap rush levels (2026-10-24, T-305c plan)
ADR-218 and the plan's table: catch 45 s with 30, 40 or 50 items (pass at 20, 30 or 40 caught); tap rush 30 s with a
score of 20, 28 or 34 to pass, a miss costing a point. Keep as a start and tune after a playtest?

## Q-183 — Splitting T-306 (2026-10-24, T-306 plan)
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-219 accepted.
ADR-219: live polls now (T-306); community quests next (T-306b); quests, categories or shop rewards unlocked by a
community goal after that (T-306c). The pushes wait for T-501 and the big-screen scenes for T-504. Agree?

## Q-184 — Live poll rules (2026-10-24, T-306 plan)
ADR-220: a live poll takes one choice or several (several still count as one vote and one payment), shows results
after voting, at close or never, and stays open 1 minute to 24 hours once sent (never past the event's end). A poll
never counts toward a category's bonus or order, so missing one blocks nothing. A poll without points still gives
Questify XP like any quest. Agree, or no XP for a poll without points?

## Q-185 — Polling instead of a live stream (2026-10-24, T-306 plan)
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-221 accepted.
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
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-243 accepted.
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
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-254 accepted.
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
**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-260 accepted.
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
**Answered by Q-590 (T-221, built 2026-11-03, migration 0146):** the limit is checked once per statement; a
hard-limited event now accepts up to 1,000 a call (ADR-631).

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

## Q-348 - T-602 switches, accent and preview: what is decided without Dhia (2026-10-31)

**Recommended (developer):** the owner can switch the shop, live polls, maps and agenda off per event; an owner or an editor picks one accent colour from six curated ones (or Questify green), and the dashboard previews Home, Quests and Rewards in Arabic or English. The logo and banner wait for the storage bucket (T-602b, Q-149). **Open:** (1) should the shop switch also refuse a reservation? As built it does not, because the reserve door spends points (tier A) and closing it needs a migration; a player cannot reach it from the app while the shop is off, and a prize already held is still handed over at the desk. (2) Should a vote on a hidden live poll be refused? As built no. (3) FR-1009 says "the owner or an editor"; as built the switches are the owner's, like every switch before them, and the accent is the owner's or an editor's. (4) Which six colours: sky, ember, rose, violet, lagoon, honey were chosen to sit with the brand deck and to pass 4.5:1 with the brand ink; a colour from the organizer's own brand is not possible by design (FR-1023). (5) The public event card and the shared-link image do not carry the accent yet; they need the banner (T-602b) and a change to a database door. **Decided (developer, delegated by Dhia, 2026-10-31):** as built; ADR-381 accepted after the T-602 review (93 GO). The poll vote, poll and vote reads and the shop reserve with their switch off are task T-602c (tier A).

## Q-349 - T-505b session points: what is decided without Dhia (2026-10-31)

**Recommended (developer):** (1) a new ledger kind `session`, paid by the door once per player and session (the pair is
the key; no client key can pay twice); (2) points are paid only while the player may play: live for real players, before
go-live for rehearsal accounts, never to staff who do not play, never while the agenda is off; (3) no boost, XP, streak or
community-goal credit, and outside operator caps; (4) editing a session's points changes future check-ins only; (5) a
player checked in cannot cancel the registration; (6) staff undo by removing the entry: attendance stays, the player is
never paid for that session again, and there is no un-check-in; (7) the session bulk target reaches who was checked in
when it runs, minus removed entries; a second bulk pays again and the confirm screen says how many came before.
**Open:** should a session with points be capped for an editor, as an editor's award is? Recommended no, as a quest's
points are not; the audit records every change of the points with the value before and after (ADR-382). **Decided (developer, delegated by Dhia, 2026-10-31):** as recommended; ADR-382 accepted after the code review.

## Q-350 - T-602c switches in the points doors: what is decided without Dhia (2026-10-31)

**Recommended (developer):** (1) the shop switch refuses new reservations and the polls switch refuses live-poll votes and
their reads, in the database, with 403 `feature_off`; plain vote quests are not live polls and stay open; (2) a retried
request that already succeeded answers as before; (3) reservations made before the switch-off stand: desk handover,
cancel and expiry work. **Open:** while the shop is off the player cannot see a prize they still hold (it is listed only in
the shop read). Recommended: task T-602d (tier B), a "Prizes to collect" card on Home from a held-prizes read that is not
behind the shop switch, and the shop-off confirmation saying how many prizes players still hold (ADR-383). **Decided (developer, delegated by Dhia, 2026-10-31):** as recommended; ADR-383 accepted, T-602d queued.

## Q-351 - T-602d prizes to collect while the shop is off: what is decided without Dhia (2026-10-31)

**Recommended (developer):** (1) a held-prizes read for the player that is not behind the shop switch, listing only the
bearer's own reserved prizes (any source) with the desk; (2) a "Prizes to collect" card on Home whenever something is held,
with Collect (collect first) or Open My QR (desk offers); (3) the shop-off note on the dashboard says how many prizes
players still hold, shown after the switch is saved (ADR-384). **Open:** should turning the shop off ask first when prizes
are held? Recommended no: the switch changes nothing for a held prize (it stays reserved, collectable and cancellable)
and turning it back on is one tap, so a question adds a step without protecting anything. **Decided (developer, delegated by Dhia, 2026-10-31):** as recommended (no question); ADR-384 accepted.

## Q-352 - T-603 live control room: what is decided without Dhia (2026-10-31)

**Recommended (developer):** (1) build the room from the existing doors and one polled read (ADR-385); (2) pause a quest and
skip a broken step go to T-603b, tier A, because they change `complete_quest`; (3) "players online" is "active in the last
15 minutes" (the app has no presence); (4) open the room before go-live so the team can rehearse the event day. **Open:**
should "online" mean something live, such as a heartbeat from the app while it is open? Recommended no for now: a heartbeat is
a write per player per minute and a new personal-data record; completions in 15 minutes is free and honest. Revisit if
organizers ask for it. **Decided (developer, delegated by Dhia, 2026-10-31):** as recommended; ADR-385 accepted after the T-603 review.

## Q-353 - T-603b pause and skip: what is decided without Dhia (2026-10-31)

**Recommended (developer):** (1) a pause stops every new start, hand awards included; work already started (a submission
waiting for review, an open quiz attempt) finishes and pays; (2) the pause's commit is the cut-off for scans in flight;
(3) a paused in-order step still holds later steps (skip it to free them); (4) skip pays nobody, the step stays
completable, unskip is allowed and its screen counts who is held again; (5) the go-live wipe clears both (ADR-386).
**Open:** should skipping pay the step's points to those who moved on? Recommended no: the team can award a group.
**Decided (developer, delegated by Dhia, 2026-10-31):** as recommended, after the code review (84, both MAJORs fixed).

## Q-354 - T-604 live points edits: what is decided without Dhia (2026-10-31)

**Recommended (developer, as the plan review decided):** (1) "also past" makes every kept completion worth the new points
times its boost (absolute target, compensating `adjust` entries, never an edit); (2) it reaches scan, code, location,
vote, survey, share, challenge, passport and meet; submission, quiz and game are future-only with one line and no choice;
(3) lowering clamps at zero, score and balance each on their own, with no reserved-prize refusal; (4) an editor's past
raise stays within the per-award cap; (5) delete with "remove" also takes the quest's first-N bonus and folded adjusts;
category bonuses and streak days stay; (6) a category holding a deleted quest cannot be deleted (ADR-387). **Open:** should
past edits reach submission and quiz quests? Recommended no for now: they pay amounts set per answer or per review.
**Decided (developer, delegated by Dhia, 2026-10-31):** as recommended, after the code review (84, both MAJORs fixed).

## Q-355 - Change sets: what is decided without Dhia (2026-10-31)

**Recommended (developer, as the plan review decided):** API-first creation (the future AI wizard, F-197), a dashboard
review page, per-item transactions with stale detection, quests, categories and rewards only, no dry run on GET; split to
T-604b (ADR-388). **Open:** should the dashboard itself offer "save as a change set"? Recommended no.
**Decided (developer, delegated by Dhia, 2026-10-31):** as recommended, after the code review (84, both MAJORs fixed).

## Q-356 - T-604b change sets and the confirmation sweep: what is decided without Dhia (2026-10-31)

**Recommended (developer, ADR-389):** a target changed since the set was made is skipped as stale; an item that edits points
goes through the live-edit door and needs its `apply` choice; 100 items a set and 20 open sets an event; the sweep asks for
the actions listed in ADR-389 and leaves what is one tap to undo (cancel an invitation). **Open:** should the dashboard let
a reviewer edit an item's body, or merge two edits of one target, before applying? Recommended no: the assistant that makes
a set (F-197) makes a new one. **Decided (developer, delegated by Dhia, 2026-10-31):** as recommended; ADR-389 accepted.

## Q-357 - T-605 guided setup: what is decided without Dhia (2026-10-31)

**Recommended (developer, ADR-390):** ten steps (FR-1846), progress only in `event_setup`, every choice saved by its page's own
operation, locked add-on cards with "Ask Questify" to the Contact page, texts as translation keys. **Open:** (a) the wizard
does not open by itself after an event is created or after sign-up (UX plan section 7 assumed it would); the Overview card
offers it. Recommended: keep the offer. (b) "Ask Questify" opens the Contact page, which has no details until T-706 and T-703's
support contact; recommended: keep it and make the page carry the contact when it exists. (c) An unlocked add-on opens its
page instead of showing a tick (the big screen has no separate on switch; its scenes are the page); FR-1755's "it can be ticked"
is met by the page. (d) The previews are one-line summaries, not pictures; recommended: pictures only when the brand art for the
player screens exists. (e) FR-1757's "asked to save or discard" belongs to the translation matrix editor (T-702), which edits
these keys. **Decided (developer, delegated by Dhia, 2026-10-31):** as recommended; ADR-390 accepted after the review.

## Q-358 - T-606 layout: what is decided without Dhia (2026-10-31)

**Recommended (developer, ADR-391):** an event's layout is its bar order and Home block order with a hidden set, stored in
`event.config` (no migration); protected items are Home, the scan button, Profile, points and balance, prizes and results, and the
history and event info links; four approved presets in code; the owner or an editor edits it on a Layout page with a live preview.
**Open:** (a) FR-1749 also names the Questify home bar, the operator bar, the Profile rows, renaming and the icon choice, edited by the
Questify team in the console; only the event's bar and Home are built. Recommended: the rest waits for T-713 (the Questify home
layout editor) and a task of its own, since each is another screen with its own protected items. (b) The four presets' names and
orders are the developer's first set; the team may want others (a preset is one entry of `LAYOUT_PRESETS`). (c) Hiding the Quests tab
is allowed; if an event should always show it, add `quests` to the protected tabs (one line, and the preset and the check follow).
(d) The editor drags with the mouse and moves with the buttons; a touch drag is not built (the buttons work on a phone-sized
dashboard). (e) Not run on a phone: the bar's order and the Home blocks in the installed app need a check on a device.
**Decided (developer, delegated by Dhia, 2026-10-31):** as recommended; ADR-391 accepted after the T-606 review (93 GO).

## Q-359 - T-607 analytics: what is decided without Dhia (2026-10-31)

**Recommended (developer, ADR-392):** joined means ever a member (so a player who left still counts); active means one completion of
any kind, a manual award included; returning means a completion on two or more event days (none in a one-day event); earned points
are the score cache (plus the score live spends took); a completion the team removed does not count; rehearsal accounts count and
are labelled; no minimum group size on this page (its audience sees named players; T-608's sponsor-facing totals need a floor); the
page has no period or sponsor filter yet. Questions for Dhia: (a) Should a quest the team awarded by hand count as
the player's activity? (b) Should "returning" also count a player who comes back on the same day after a long gap? (c) Is a minimum
group size wanted before a count of one or two players is shown (for example a sponsor's own players, T-608)? (d) Is a period filter
(whole event, today, last 7 days) wanted before T-608? (e) Not run on a phone: the page was read in a browser at 360 px, not on a device. **Decided (developer, delegated by Dhia, 2026-10-31):** as built; (c) a floor goes with T-608's sponsor-facing totals; (d) the period filter waits for T-608. ADR-392 accepted.

## Q-360 - T-608 exports, sponsor totals and the report: what is decided without Dhia (2026-10-31)

**Recommended (developer, ADR-393):** server-built files, each audited; only join-card fields; sponsor view and file are totals with no
player; counts of 1 to 4 players are left out for anything made for a sponsor and for the report's item-level counts; the PDF is the
browser's print of a one-page sheet; no period filter; no event logo yet. Questions for Dhia: (a) Is a floor of 5 right (a sponsor
sees no player, but a small event may never reach 5 on a quest)? (b) Should the organizer ever export the player files filtered to
one sponsor's quests (a named list of who completed them), or is totals-only enough (FR-1626 reads as totals-only)? (c) Is a period
filter (today, last 7 days) wanted, given a file carries times? (d) The event logo on the report waits for the storage bucket
(Q-149): is the event's name enough until then? (e) Should the spreadsheet headers use an event's renamed words ("Mission" for
"Quest")? (f) Not run on a phone or in a PDF reader: the page was printed to PDF in a headless browser and counted as one page. **Decided (developer, delegated by Dhia, 2026-11-01):** as built; (e) no, Questify's own words in the files for now. ADR-393 accepted.

## Q-361 - T-609 usage view: what is counted now, and who counts login SMS, promotional email, push and storage (2026-11-01)

**Recommended (developer, ADR-394):** the console's Usage page counts what the platform already records (events, players, invitations sent, alert
emails sent) per organizer and per event; the claim fix, the quest-item stock source and no real mail are as ADR-394 says. **Open:** FR-1730 also asks for
login SMS, promotional email, push volume and storage. Each needs a durable count with a producer: a per-day counter written by the player sign-in (tier A), by
the invitation sender and by the push worker, and a storage figure once photo uploads exist (Q-149, parked). Recommended: add one `usage_day` table
(event, day, metric, count) and let each of those three producers add a count in its own task (T-703 holds the console's other platform tuning), and keep the page
as it is until then. Not asked of Dhia: no product direction changes. **Decided (developer, delegated by Dhia, 2026-11-01):** as recommended; ADR-394 accepted.

## Q-362 - T-610 Home editor: what is decided without Dhia (2026-11-01)

**Recommended (developer, ADR-395):** the organizer's banner, quick links, featured item and cards are stored in the event's layout as plain,
bounded text; the taps are the agenda, map, shop, one quest or an https link (asked before it opens); the podium starts hidden; presets and
Reset to default keep the organizer's words. Questions for Dhia: (a) Is a plain text banner slide acceptable until pictures arrive (Q-149), or
should the banner wait for T-610b? (b) Should a web link ever open without asking, or only from a list of sites the Questify team allows (a link
to a stranger's site from inside a store app can be reported as unsafe)? (c) Should a text card or slide be refused if it holds a phone
number or an address (the announcement rule does), or is an organizer free to write "call 920..." on their own Home? (d) The podium
duplicates the ranking card a little: should it replace it by default on new events? (e) Not run on a phone: the slider, swipe in Arabic and the
link question were checked in tests and a browser preview only. **Decided (developer, delegated by Dhia, 2026-11-01):** as recommended after the T-610 review; ADR-395 accepted.

**(c) decided (developer, delegated by Dhia, 2026-11-01, T-610 review):** allowed. An organizer may write contact details in their own Home text; the audit guard checks key names only, so that text also sits in the layout audit entry (SECURITY.md, Home blocks). No filter is added; revisit only if a store reviewer or a complaint asks for one.

## Q-363 - T-611 ranking, Quests and shop layouts: what is decided without Dhia (2026-11-01)

**Recommended (developer, ADR-396):** the looks are choices in the event's layout; the defaults are today's look (list, scores shown, list,
list), so no live event changes; places only removes the score from the ranking answer and from the revealed results on the server; a
preset never changes the looks. Questions for Dhia: (a) Should places only also apply to the big-screen ranking scene (a venue screen
that shows scores beside an event set to places only)? FR-1832 names the player's ranking; the scene has its own picker. (b) Should
places only also hide the player's own points on Home (now: unchanged, it is their own record and balance)? (c) The shop's default is
"list" (stacked cards, as today) although the requirement names the grid first: keep? (d) Not run on a phone: podium and grids were checked by
layout maths, the dashboard preview and the Hermes bundle only; please look at an Arabic small Android phone. **Decided (developer, delegated by Dhia, 2026-11-01; T-611 review 93 GO):** (a) yes: the big-screen ranking scene follows places only, done in
migration 0106 (`screen_ranking` leaves the score out unless the layout says it is shown; the scene draws the place alone when no score comes); (b) keep:
the player's own points on Home stay as they are (their own record and balance); (c) the shop's default stays the list; (d) the phone check stays with
Dhia (an Arabic small Android phone: podium and grids). ADR-396 accepted.

## Q-364 - T-612 prize reservation and the desk sale: what is decided without Dhia (2026-11-01)

**Recommended (developer, ADR-397):** (a) the player confirms each sale on their own phone (Pay), not the operator's tap alone (ADR-137);
FR-1834's "when they confirm" is read as the player's Pay. (b) Digital rewards stay in the app when reservation is Off. (c) A sale needs a
My QR scan (later the wallet pass), not the name or phone search. (d) Turning Off needs the desk's place; reservations already made stand,
and the dashboard's confirmation names how many are still held. (e) The desk sells only while reservation is Off. (f) No push for an
offer. (g) The desk sees whether the player can buy each reward ("Not enough points", "Reached the limit", "Sold out"), never their balance.
The offer card names the desk's place. Questions for Dhia: is the player's Pay the confirmation you want (a), and should digital rewards
also move to the desk when Off (b)? Not run on a phone: please try Offer and Pay with two phones at a rehearsal. **Decided (developer, delegated by Dhia, 2026-11-01):** a to g as recommended: (a) rests on ADR-137, which Dhia accepted; (b) digital rewards stay in the app (the desk cannot hand over a code). ADR-397 accepted after the code review (93 GO). The two-phone rehearsal check stays with Dhia.

## Q-365 - T-613 event info page and the extra page: what is decided without Dhia (2026-11-01)

**Recommended (developer, ADR-398):** (a) the official rules cannot be hidden from the info page; (b) a contact can be an email address, a phone number or a website, and a tap opens the phone's mail or phone app (a website asks first); (c) the sponsors and the free text section of the builder's first list are not built, since Home's sponsors block and the extra page cover them; (d) the venue text is the address and opens maps by its words, and the venue pin is not sent to players; (e) the About text is edited on the Layout page, not in the event form; (f) the extra page holds text, lists and links, with pictures in T-613b. Questions for Dhia: should the maps button open at the venue pin instead of searching the venue's words (it needs the pin in the player's Home read), and do you want a sponsors list on the info page? Not run on a phone: please open Event info and the extra page on an Arabic small Android phone. Decided (developer, delegated by Dhia, 2026-11-01; T-613 review 86, its MAJOR fixed): ADR-398 accepted.

## Q-366 - T-614 event text overrides: what is decided without Dhia (2026-11-02)

**Recommended (developer, ADR-399):** (a) the approved list is the six bar names (Home, Quests, Scan, Rewards, Ranking, Profile), which are also the screen and shop titles; (b) the currency word is edited in Event words, not here; (c) a label may drop the event's own word placeholder (Quests renamed Adventures) but never a placeholder that carries a value; (d) at most 24 characters per label and language; (e) a label renamed in one language only shows Questify's text in the other. Questions for Dhia: should other short texts join the list (for example the join button, the points heading or the Scan screen's title), and should an organizer be able to rename the Questify-wide tabs? Not run on a phone: please open an event after renaming Rewards to Prizes on a small Arabic and an English Android phone. Decided (developer, delegated by Dhia, 2026-11-01; T-614 review 88, its MAJOR fixed): ADR-399 accepted.

## Q-367 - T-615 name display: what is decided without Dhia (2026-11-02)

**Status:** Accepted (developer, delegated by Dhia, 2026-11-02; T-615 privacy review 91 GO). The staff view (no per-player notice) is acceptable; counsel is to confirm that volunteer operators count
as the organizer (batched in T-807).

**Recommended (developer, ADR-400):** (a) refuse widening to "full name to everyone" once a player who was not told is in, instead of asking
those players again (a re-acceptance prompt is a later task); (b) the staff read (operator scan, prize desk) needs the setting only, no per-player
notice, because the organizer's staff already receive the full-name answer; (c) the card version stays 0.2 and the audience shown is
recorded in `enrollment.name_notice`; (d) a duplicated event starts on usernames; (e) the session check-in's result screen does not show the
full name yet; (f) counsel's answer on Q-080 can still narrow this (for example, no "both" for everyone); the default is usernames, so
nothing is shown until an owner chooses.

## Q-368 - T-616 owner Inbox: what is decided without Dhia (2026-11-02)

**Status:** Accepted (developer, delegated by Dhia, 2026-11-02; T-616 review 92 GO).
**Recommended (developer, ADR-401):** (a) the Inbox counts and links; the actions (Reply, Solved, Escalate, Ban) stay on the Help desk and Players pages;
(b) reported players are the Help desk's `report_player` requests and prize problems its `prize` requests (Q-209); (c) reported content is T-705's
moderation queue (Q-219), so the event team sees no content list yet; (d) the page shows no full name and no contact detail, only what the Help desk
and Players pages already show; (e) it does not poll. Questions for Dhia: should the event team also see reports of a quest, text or image (FR-1411) in its
own Inbox once T-705 exists, or only Questify's moderators?

## Q-369 - T-617 operator activity and the staff briefing: what is decided without Dhia (2026-11-02)

**Status:** Proposed (developer, ADR-402).
**Recommended (developer):** (a) quiet means 30 minutes without an action (FR-1844's own example), shown as a badge and counted in the first tile; (b) the activity counts the event's day and the
last hour, and names the last action whatever it was (a scan, a check-in, an award, a hand-over, a cancel, a review, a reply); (c) a briefing reaches every operator of the event whatever their
abilities, cannot be muted, and has a title and a text of 140 characters in Arabic and English so nothing is cut; (d) it may be sent before the event starts and until it ends, 3 an hour and 10 a day;
(e) the operator-invite push is dropped (no account exists when the invite is made). Questions for Dhia: should a briefing be able to name a subset (the operators of one station, or one ability),
and should operators be able to acknowledge it? **Decided (developer, delegated by Dhia, 2026-11-02):** as built (all current operators, no acknowledgement); either is a small addition if Dhia asks. ADR-402 accepted.

## Q-370 - T-618 go-live readiness checklist: what is decided without Dhia (2026-11-02)

**Status:** Accepted (developer, delegated by Dhia, 2026-11-02; T-618 review 82, its three MAJORs fixed).
**Recommended (developer):** (a) "blocks nothing" means the checklist never stops an activation request or an activation; an item can still read Needed (blocking) when players could not use the event;
(b) the console lists events starting within 14 days (and ones whose start passed without going live), at most 100; (c) the owner sees the card only while the event is a draft or scheduled, and at the end
of the guided setup; (d) "quest QR codes printed" is not an item because nothing records printing. Questions for Dhia: should the console be able to email the owner a reminder from this list, should the
14 days be a console tuning number (T-703), and should Questify record when a QR sheet was printed or downloaded so the F-347 item can exist? **Decided (developer):** as built until Dhia says otherwise.


## Q-371 - T-601b event templates: what is decided without Dhia (2026-11-02)

**Status:** Proposed (developer, 2026-11-02; ADR-404).
**Recommended (developer):** (a) the four templates (conference, festival, campus, corporate) are rows of a closed table seeded by migration 0115, edited later by the console (T-709), not shipped code; (b) a template holds no item reward, no quiz, no passport, no location and no typed code, and every reward starts with no stock, so the organizer finishes the setup before anything can be redeemed; (c) the quest texts are neutral starting points (booths, halls and stalls are named by number or kind, never by a real place) that the organizer edits; (d) the wizard's "Start from" applies only to a draft with no quest and asks first; (e) the Arabic follows the ux-araby voice (simplified Modern Standard, masculine imperative), Western digits. Questions for Dhia: should organizers be able to save their own event as a private template (it would reuse the duplicate door), should the Saudi-specific templates that ADR-083 left out (Ramadan, national day) be added now as rows, and should a template be able to carry item rewards by also asking for the prize desk place in the picker? **Decided (developer):** as built until Dhia says otherwise.

## Q-372 - Does the organizer see the suspension reason? (T-701)

**Status:** Answered (Dhia, 2026-11-02). The organizer sees the reason Questify wrote; players see only that the event is
unavailable. Built in T-701 (ADR-406).

## Q-373 - Support access: approval, length, notice (T-701)

**Status:** Answered (Dhia, 2026-11-02). 15 minutes, fixed; no notification to the organizer, no banner, no organizer
approval or "end access"; it happens and is recorded in Questify's audit log only ("It will be logged only, but the
organizer or the owner might not know about it. That's fine."). Built in T-701 (ADR-407, ADR-409).

## Q-374 - How support appears in the organizer's history (T-701)

**Status:** Answered (Dhia, 2026-11-02). Changes made by support are labelled "Questify support" wherever the
dashboard's own history shows an actor; the admin id stays in Questify's audit log. Built in T-701 (ADR-408).

## Q-375 - Merging two organizer accounts (T-701b)

**Status:** Answered (Dhia, 2026-11-02). Dropped from v1 (ADR-410).

## Q-376 - Mailbox for urgent-report alerts (T-701b)

**Status:** Answered (Dhia, 2026-11-02). The same address Questify sends email from (`MAIL_FROM`), stored as
configuration data, not hard-coded. To build in T-701b (ADR-410).

## Q-377 - Support writes while an event or organizer is suspended (T-701)

**Status:** Accepted (developer, delegated by Dhia, 2026-11-02; T-701 plan review 80, code review 88, its MAJOR fixed); ADR-406).
**Recommended (developer):** support keeps writing while suspended (to fix what led to the suspension, then
reactivate); the ledger stays closed to support as to everyone.

## Q-378 - Are legal and consent texts editable in the text matrix? (T-702)

**Status:** Decided (developer, delegated by Dhia, 2026-11-02; ADR-411 accepted after the T-702 review). **Recommended:** no. They are listed read-only. Their keys (`signIn.consent*`, `signIn.terms`,
`signIn.privacy`, `signIn.accept`, `signIn.versions*`, `submission.guidelines*`, `staff.accept.*` and the whole `deletion.`, `optOut.`
and `marketing.` areas, plus any future `legal.`, `consent.`, `acceptance.`, `privacy.`, `guidelines.`, `reaccept.` key) change with a
release. **Why:** FR-1781 makes a legal document a versioned thing players accept again; the matrix keeps no version record, and
the store-compliance gate names the deletion and marketing screens. **Open:** if you want them editable, they need a version
number and re-acceptance (T-707), and the lock list in `packages/shared/src/i18n/locked.ts` shrinks. The lock is broad on purpose
(a button such as `marketing.save` is locked too); say so if a typo there should be fixable from the console.

## Q-379 - What does "missing Arabic" or "missing English" mean? (T-702)

**Status:** Decided (developer, delegated by Dhia, 2026-11-02; ADR-411 accepted after the T-702 review). **Recommended:** the text a player sees in that language has no letter of that language
(placeholders left out) while the other language does, such as an English sentence copied into the Arabic box. Every shipped key has
both languages (a test keeps it so), so today the filter shows the few texts that are English or Arabic only on purpose (brand names,
`QR`); it exists to catch a copied or forgotten text. **Open:** if FR-1765 meant something else (a text an admin emptied), note that
an empty box returns the language to the shipped text, so a language can never be empty.

## Q-380 - How fast does the phone pick up a text, and where else is the store read? (T-702)

**Status:** Decided (developer, delegated by Dhia, 2026-11-02; ADR-412 accepted after the T-702 review). **Recommended:** 30 seconds in the foreground and at each return to it, with the last
working copy kept; no push to phones. **Open:** (a) the organizer dashboard and the web console still show the shipped text outside
the guided setup (`wizard.*`, `setup.*`); an edit to any other dashboard text changes the phone, not the dashboard. Recommended: leave
it until a dashboard page is meant to be editable (the matrix lists every key, so an admin may edit a dashboard-only text and see no
change). (b) A phone that is offline for days keeps the last copy it had. (c) A text read outside the provider (a push body built by
the server, the splash) is not covered.

## Q-381 - Placeholder chips beside the box, not inside the text (T-702)

**Status:** Decided (developer, delegated by Dhia, 2026-11-02; ADR-413 accepted after the T-702 review). **Recommended:** as built (a free box, chips under it, the save waits). **Open:** if you want
a chip to be unremovable inside the text, that needs a custom editor (it breaks caret and selection in mixed Arabic and English
lines) and a way to move a chip, since Arabic often puts a number before or after a noun differently from English.

## Q-382 - What the health view cannot show yet (T-709)

**Status:** Decided (developer, delegated by Dhia, 2026-11-02): as recommended; ADR-416 accepted after the T-709 review.
FR-1783 asks for each live event's players online and its errors, and for error counts. The database records neither: there is
no presence record, no request error counter, and the tickers keep no run record (they log). The view shows each live event's
points entries in the last hour, the failed and uncertain sends of the last day, and the symptoms of a stopped ticker.
**Recommended (developer):** leave as built. If a stopped ticker with nothing to do must also be seen, add a `job_status` row per
ticker written at most once every 30 seconds; for request errors use the host's log search.

## Q-383 - SMS delivery rate covers invitation messages only (T-709)

**Status:** Decided (developer, delegated by Dhia, 2026-11-02): as recommended; ADR-416 accepted after the T-709 review.
The SMS tile's rate is the share of invitation messages delivered in the last 7 days (the campaigns' counters: sent over sent,
failed and unknown). Sign-in and service SMS keep no outcome, so they are not in it. The rate is judged from 20 messages:
a warning under 90 percent, down under 50 (constants until T-703).
**Recommended (developer):** keep; record the outcome of sign-in SMS only if support needs it.

## Q-384 - Admins see each other's browser and address (T-709)

**Status:** Decided (developer, delegated by Dhia, 2026-11-02): as recommended; ADR-417 accepted after the T-709 review.
To tell a lost laptop from a phone, an admin sees the browser and address of every other admin's open sessions, as each admin
already sees their own. Every such read is audited with the account id.
**Recommended (developer):** keep; show the browser only if the address is judged too much.

## Q-390 - Is a visual editor wanted for a template's setup? (T-709b)

**Status:** Accepted (developer, delegated by Dhia, 2026-11-02; T-709b review 82, achievements made name-only): as recommended; ADR-427.
The Catalog page edits a template's categories, quests and rewards as JSON checked by the template schema. A form with a card per
category and quest would be friendlier, and is a large piece of UI for a few edits a year by Questify's own team.
**Recommended (developer):** keep the JSON editor; build the visual editor only if the team edits templates often.

## Q-391 - Template order and new gem shop items (T-709b)

**Status:** Accepted (developer, delegated by Dhia, 2026-11-02; T-709b review 82, achievements made name-only): as recommended; ADR-425.
A new template goes last and cannot be moved; there is no move up or down. New shop items and item names wait for T-709c
(an item in the shop is frozen, kinds and ids are fixed, art is shipped).
**Recommended (developer):** add move up and down to templates only if the list grows past five or six; do items in T-709c.
## Q-385 - A retired username stays out of use until it is un-retired (T-704)

**Status:** Proposed (developer, 2026-11-02; ADR-420).
When an admin renames a player, the old name is retired for everyone, the renamed player included, until T-705's word-list
page un-retires it. A name retired by mistake (a typo in the console) stays blocked until then.
**Recommended (developer):** keep; un-retire comes with T-705.

## Q-386 - A sign-in reset also clears the failure counter of the account's contacts (T-704)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-421 accepted. Was: Proposed (developer, 2026-11-02; ADR-421; plan review MINOR).
The usual reason for a reset is a player locked out by wrong codes (their own, or a stranger guessing at their number);
keeping `player_fail_contact` would leave them locked out for up to a day after support acted. The guesses this allows
again are bounded: 3 tries per code, the per-address failure window stays, and each reset costs an admin a reason, an
audit entry and one of 30 an hour.
**Recommended (developer):** clear both the code and the failure counters of the account's own contacts; never the address
or install counters.

## Q-387 - A player who lost every contact on the account cannot be helped back in (T-704)

**Status:** Proposed (developer, 2026-11-02; ADR-421).
No route sets or changes a player's contact and nothing returns a code, so there is no account-takeover path. The price: a
person who lost both the phone number and the email on the account starts a new account. Support may still reveal the
masked contacts' full values to check a claim (ADR-422), but cannot move access.
**Recommended (developer):** keep; revisit only with a verified identity check, which v1 does not have.

## Q-388 - Who may see a player's full contacts, and how often (T-704)

**Status:** Proposed (developer, 2026-11-02; ADR-422).
Any active platform admin may reveal a player's full phone and email for a support or legal request, with a note, at most 20
times an hour; each reveal is an action row the record shows and an audit entry. There is no second-admin approval.
**Recommended (developer):** keep for launch (a handful of admins); add a second approval if the team grows.

## Q-389 - What an erased account shows in the console (T-704)

**Status:** Proposed (developer, 2026-11-02).
Search never finds an erased account. Opened by id (an old link), its record says "Deleted account" with the deletion date
and nothing else; no action is offered and none is accepted (404), as FR-1776 has no restore.
**Recommended (developer):** keep.


## Q-392 - The reasons a ban can be lifted for (T-705)

**Status:** Proposed (developer, 2026-11-02; ADR-429).
A lift needs a reason code like every other admin action: `appeal_upheld`, `mistake` or `other`, plus the internal note.
The ban's own codes (`cheating`, `abuse`, `spam`, `prize_fraud`, `terms`) are what the player is shown, in fixed Arabic
and English words.
**Recommended (developer):** keep both lists; add a code when support meets a case none of them fits.

## Q-393 - A banned player misses a raise of a quest's points (T-705)

**Status:** Proposed (developer, 2026-11-02; ADR-430).
When an organizer raises a quest's points for past completions, a banned player is skipped (the wall pays them nothing);
a lowering still applies. If the ban is lifted later, that raise is not replayed for them.
**Recommended (developer):** keep: the organizer can award the difference by hand after a lift; replaying would need a new
ledger path on the core.

## Q-394 - A block does not hide a player from staff, the big screen or an earlier meeting (T-705)

**Status:** Proposed (developer, 2026-11-02; ADR-431).
A block hides the other player from the blocker's own boards, results and profile reads, and stops meet quests between the
two. The event team's reads (players, flags, help desk, desk, station), the console, the big screen and the pass of a
meeting that already happened still name both: a block is one player's choice and does not bind a team or a room.
**Recommended (developer):** keep; a player who needs the team to act reports the other player (T-312, T-705b).

## Q-395 - A username reported while the event's help desk is off reaches Questify only (T-705b)

**Status:** Proposed (developer, 2026-11-02; ADR-433).
A username reported from an event's ranking opens the team's `report_player` ticket only when the event's help desk is on
(the team has no inbox otherwise); the report always reaches Questify's queue.
**Recommended (developer):** keep; an organizer who wants reports turns the help desk on.

## Q-396 - Reporters are not told what happened to their report (T-705b)

**Status:** Proposed (developer, 2026-11-02; ADR-433, plan D16).
The app thanks the reporter ("Thanks. Questify will review this.") and sends nothing when the report is handled.
**Recommended (developer):** keep for v1; an outcome notice would need its own wording and must never name the other side.

## Q-397 - A held reward can still be named by a quest item or a community goal (T-705b)

**Status:** Proposed (developer, 2026-11-02; ADR-434).
Unpublishing a reward takes it out of the shop, the goal, the desk and the reserve door, and out of pushes. A quest item that
hands it out as a prize still names it (its read was not restated). A community goal's unlock marker no longer names it to a
player (migration 0166); the team's own `community_goals` keeps the name, since the team sees its held items and the reason.
**Recommended (developer):** leave until a report shows the need; the admin can suspend the event meanwhile.

## Q-398 - Gems already paid for a revoked tier stay with the player (T-709c)

**Status:** Proposed (developer, 2026-11-02; ADR-439).
The gem ledger has no correction source (ADR-285), so revoking a fraudster's tiers hides the badges and stops unpaid gems
but leaves gems already paid. A banned player cannot spend them.
**Recommended (developer):** keep; add a correction source only if a lifted ban with fraud gems becomes a real case.

## Q-399 - Rewards of a lower XP curve arrive at the player's next sync (T-709d)

**Status:** Proposed (developer, 2026-11-02; ADR-440; re-planned 2026-11-02).
A curve save writes no player row. A player's stored level, new level items and level-up gems are written at their next
sync (or next XP); the player's own screens and the console derive the level from XP at once, while the public profile
shows the stored level until then. A caught-up level carries the player's latest XP entry, so a replayed completion screen
may name it.
**Recommended (developer):** keep; the app syncs on opening Profile or Questify.

## Q-400 - The streak milestone XP gets its editor in T-703 (T-709c)

**Status:** Proposed (developer, 2026-11-02).
`questify_streak_milestone` is append-only (0068), so editing it needs a design of its own; T-709c leaves it out.
**Recommended (developer):** T-703's tuning page, with a new versioned row per change.

## Q-401 - How long a curve save may hold new level-ups (T-709d)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-440 accepted. Was: Proposed (developer, 2026-11-02; ADR-440; re-planned 2026-11-02).
The save holds every `xp_level` row FOR UPDATE, so a scan that reaches a new level waits for it (scans that reach no new
level, syncs, sign-ups and buys never wait). The save waits at most 1 second in all for its locks (one budget for
the whole save, not per lock), then answers 503 `busy`.
**Recommended (developer):** measure on the 300,000-player fixture; budget 200 ms held, under the API's 2 s lock timeout.
**Measured (T-709d build, 2026-11-02; `apps/api/test/perf/xp-table-timing`, this PC, another worker's tests on the same
database server):** a 100-level save with every kind of change 159 to 316 ms; a save removing 70 levels 117 to 203 ms;
the preview 191 to 307 ms; a scan queued behind a save finished in 167 to 616 ms. Within budget unloaded; under load the
1 s lock budget is what bounds a queued scan. Re-measure on a staging-sized server before launch.

## Q-402 - A shop item's art is frozen once it has a shop row (T-709d)

**Status:** Proposed (developer, 2026-11-02; ADR-441; re-planned 2026-11-02).
Buyers keep the art they saw; the admin can rename a shop item (on sale or retired) but changes its art by retiring it and
adding a new one. A level reward's art is frozen once anyone reached its level.
**Recommended (developer):** keep.

## Q-405 - Should every player route refuse until the new legal version is accepted? (T-707, Q-095 part 1)

**Status:** Decided by developer (2026-11-02; ADR-446; the T-707 review found the launch gate alone skippable by a modified app).
Yes, for writes: a player who has not accepted the terms and privacy policy in force gets 403 `legal_acceptance_required` on every
player write, except accepting, the deletion code and removing this phone's push device. Reads stay open, so a running screen
and the acceptance page keep working; the app reloads the profile on the 403 and shows its acceptance screen.
Counsel may still want to confirm the wording of the screen (T-807).

## Q-406 - Does a new legal version need a notice period before it binds? (T-707)

**Status:** Proposed (developer, 2026-11-02; ADR-445).
A published version is in force at once. Some laws and store rules want advance notice of a material change.
**Recommended (developer):** keep for v1; if counsel wants a notice period, add an effective date to `legal_version` and let
`legal_in_force()` ignore versions not yet effective (the publish form already takes a note for the reason).

## Q-407 - When counsel's wording is final, how does it replace the drafts? (T-707, Q-288)

**Status:** Proposed (developer, 2026-11-02; ADR-445).
The seeded 0.1 versions show the draft files in `docs/legal/`. Counsel's final text is published as 1.0 of each document in the
console (Arabic and English), after which the pages show the published text and the drafts can be deleted from `docs/legal/`.
**Recommended (developer):** publish 1.0 through the console in the T-807 batch; keep the draft files until then.

## Q-410 - Which of FR-1770's other numbers should be tunable? (T-703)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-451 accepted. Was: Proposed (developer, 2026-11-02; ADR-451).
FR-1770 also names the QR refresh time, the login-code limits, the default reservation time and the push and SMS limits. They live in
code (the throttle buckets in `src/auth/throttle.ts`, per-event reservation settings, push and SMS senders), each with its own tests;
only the numbers the database reads (rehearsal cap, readiness days, flag burst) became tuning numbers.
**Recommended (developer):** make a number tunable when someone needs to change it during an event; add it to the registry with its
range and its reader in that change.

## Q-411 - Should a switched-off feature's message also show where the feature used to be? (T-703, ADR-453)

**Status:** Proposed (developer, 2026-11-02).
FR-1769 asks for a hidden feature "as if it were absent" and for a message players see; the message is on Questify Home now.
**Recommended (developer):** keep for v1; revisit after the first real switch-off.

## Q-412 - XP on repeats and "XP by difficulty" in FR-1734 (T-703)

**Status:** Proposed (developer, 2026-11-02).
The username switch and the daily streak are platform switches (this task); XP amounts are T-709c's Amounts editor. A setting
"XP on repeats" does not exist: a quest cannot be repeated for points today (ADR-180), so the setting has nothing to switch.
**Recommended (developer):** leave FR-1734's repeat part open until a repeatable quest type is designed.

## Q-420 - Should the login-code SMS read its template as soon as T-706b lands? (T-706, ADR-460, ADR-461)

**Status:** Proposed (developer, 2026-11-03).
The sign-in text is code (`smsText`) and is on the sign-in path, which is core. T-706 only stores and checks the slot.
**Recommended (developer):** T-706b reads `login_code_sms` with the code text as the fallback when the row cannot be read, so a
database failure never stops a sign-in, and keeps the current text as the seed. Tier A review for that change.

## Q-421 - Which sender sends promotional email, and do campaigns share the one-invitation-a-week cap? (T-706, T-409 note, ADR-331)

**Status:** Proposed (developer, 2026-11-03); answered in T-706b: the cap is ADR-534 (built for push), the sender ADR-535 (T-706c
builds it, and it waits for an in-region provider, Q-034).
**Recommended (developer):** a promotional mailbox separate from the sign-in one, with `List-Unsubscribe` carrying the signed opt-out
link, sent from a Saudi-resident provider (Q-034 family); campaigns share the cap of one promotional message a week per player on
the channel (a player who got an invitation gets no campaign the same week), so the two features cannot together be the spam
Dhia wants to avoid; transactional mail is not counted.

## Q-422 - Does privacy need its own contact address? (T-706, ADR-462)

**Status:** Proposed (developer, 2026-11-03).
The legal drafts have two placeholders, the support contact and the privacy contact; both now show the support email.
**Recommended (developer):** keep one address for v1 (the privacy policy only asks for a way to reach us); add a fourth field
to `support_contact` when counsel or the PDPL regulator asks for a named data-protection contact.

## Q-440 - Is the in-app JSON download enough for PDPL's right of access, and does it need a fresh code? (T-708, counsel)

**Status:** Open (developer, 2026-11-03; ADR-480, ADR-485).
The player downloads a JSON file from Settings with their signed-in session; no fresh code is asked. A stolen session could take the full contacts; the notice, the audit entry and the 3-a-day limit make it visible and small. Counsel: is a machine-readable JSON file an acceptable form, what is the answer deadline for a request made outside the app, and is a fresh code needed?
**Recommended (developer):** keep the session only; add the deletion flow's fresh code if counsel asks.

## Q-441 - How does an admin hand an exported file to the person or authority who asked? (T-708, counsel)

**Status:** Open (developer, 2026-11-03; ADR-480).
The console downloads the file in the admin's browser. Personal data never goes into an email from the product. Counsel: which channel is acceptable for a data subject and for an authority, and what proof of identity must the admin see first?
**Recommended (developer):** decide with counsel before launch; build a signed link only if the answer needs one.

## Q-442 - May Questify leave fraud flags, reports by others and internal notes out of an export? (T-708, counsel)

**Status:** Open (developer, 2026-11-03; ADR-481).
Also for counsel: a banned player cannot use Download my data (`own_data_export` answers DR404 unless the account is active); their access request goes to an admin, whose export covers a banned account. Is that enough for the right of access?
**Recommended (developer):** leave them out (fraud prevention, other people's data) and keep the reason in the catalog; keep the self-service download for active accounts and serve a banned player through the admin export.

## Q-443 - Backup retention, log retention and the privacy policy wording for erased data (T-708, T-019, counsel)

**Status:** Open (developer, 2026-11-03; ADR-484).
Erased accounts live on in backups until they age out, and re-applying erasures after a restore reads `player.deleted` log lines. Unknown: CranL's log retention, the backup retention T-019 sets (35 days proposed), and the privacy policy sentence counsel wants.
**Recommended (developer):** 35-day backups, logs kept at least as long, and a policy sentence naming the window.

## Q-444 - Should the player be told when an admin exports their data? (T-708, counsel)

**Status:** Open (developer, 2026-11-03; ADR-483).
An authority's request may require silence; a person's own request does not need it.
**Recommended (developer):** no notice for admin exports until counsel says otherwise.

## Q-445 - Data requests for staff and organizer accounts, and a second admin for an erasure (T-708)

**Status:** Proposed (developer, 2026-11-03; ADR-483).
T-708 covers players only; `staff_user` (organizer teams, admins) has its own lifecycle. One admin can erase a player with a reason, a case reference and the typed username.
**Recommended (developer):** staff requests are handled by `staff-cli` until a task needs a console page; no second-admin approval in v1, since the audit entry and the per-admin limit cover it.

## Q-450 - Should an owner email change wait 24 hours before it applies? (T-701b)

**Status:** Proposed (developer, 2026-11-03; ADR-491).
A hold would give the real owner a day to press Stop from the old address if an impostor fooled support; it would also leave
an owner who lost their mailbox locked out for a day, often during a live event.
**Recommended (developer, revised after the plan review 82):** no hold when the owner types the current password on the
confirm page; a 24-hour hold, cancellable from the old address, when the owner does not know it. On the password path the
Stop link alerts support instead of cancelling.

## Q-451 - Should tickets escalated from a live event also be urgent? (T-701b, ADR-496)

**Status:** Proposed (developer, 2026-11-03).
FR-1732 speaks of reports; escalated help-desk tickets have their own Tickets page and order.
**Recommended (developer):** not in v1; revisit after the first live events.

## Q-452 - What counts as a live event for urgency? (T-701b, ADR-493)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** `event.status = 'live'` when the report arrives; rehearsal (draft or scheduled) reports are normal.

## Q-453 - May the urgent-report alert use the sign-in mail transport? (T-701b, ADR-494)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-494 accepted. Was: Proposed (developer, 2026-11-03).
The organizer alert transport is off (ADR-360) because it mails organizers' addresses. The team alert goes to Questify's own
address and carries ids, names of events and organizers, reason codes and a console link, no personal data.
**Recommended (developer):** yes, bounded so it can never starve sign-in mail: one digest per 10 minutes, 100 a day on its
own budget bucket (never `outboundMailPerDay`); past that only the console badge.

## Q-470 - Which blocks of Questify home can never be hidden? (T-713, ADR-511)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (worker):** notices, the typed event code, the account email, operator mode, invitations and My events: each is a
duty (a message the platform owes players, the way in without a camera, account recovery, staff and invitees reaching their
event). They can be moved. The banner, the streak, the two daily games and the Questify quests can be hidden.

## Q-471 - May a Questify home slide open the app's own screens? (T-713, ADR-512)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (worker):** not in v1: a slide opens nothing or an https link. The gem shop, Explore and the Questify quests are
the first candidates; each needs a tap kind the older apps ignore safely (an unknown kind drops the slide, not the banner).

## Q-472 - Pictures on Questify home slides (T-713, ADR-512; Q-149)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (worker):** with T-610b, once photo storage exists (Dhia: later). The slide shape gains an optional `image`;
older apps already drop a field they do not know.

## Q-473 - How does this banner relate to the scheduled message to all players (FR-1772, T-703b)? (T-713)

**Status:** Proposed (developer, 2026-11-03).
A banner message scheduled for a time and an end time is a different thing from this always-on slider.
**Recommended (worker):** keep both: T-703b's scheduled message draws in the `notices` block with the maintenance message
(a notice with an end time; that block can move but never hides), and the slider stays the admin's standing content.

## Q-460 - Should the override also reach boosts, community, meet-someone and mini-games? (T-711, ADR-500)

**Status:** Proposed (developer, 2026-11-03).
Their platform switch is read platform-wide in code and their SQL rules are in the points path. **Recommended (developer):** yes, in T-711b as a tier A task: the four SQL rules call `feature_enabled`, the four TypeScript readers take the event, the community tick decides `mayStart` per goal's event, with a plan review and mutation on the touched TypeScript.

## Q-461 - Should a Questify-wide or compliance-gated feature be overridable per organizer? (T-711, ADR-500)

**Status:** Proposed (developer, 2026-11-03).
Location quests wait on the store privacy answers; invitation campaigns on consent and the promotional SMS sender; the daily games, streak, push and username changes have no organizer. **Recommended (developer):** no. An override that opens location quests for one organizer would put the store declaration (ADR-208) at risk.

## Q-462 - Is Ask Questify a contact link or a recorded request? (T-711, ADR-502)

**Status:** Proposed (developer, 2026-11-03).
FR-1827 says "an Ask Questify request" and that an approved request makes the switch work. **Recommended (developer):** build the recorded request in T-711b (one row per event and feature, the owner taps once, the console lists open requests with Allow and Decline, Allow is the existing unlock); until then the card opens the Contact page.

## Q-463 - May an admin forbid an ordinary feature for one event? (T-711, ADR-502)

**Status:** Proposed (developer, 2026-11-03).
FR-1827's "only if Questify has allowed it for that event" could mean every feature needs a per-event allowance. **Recommended (developer):** no; only add-ons are allowed per event. A feature to hold back from one organizer is an override Off (ADR-501); a risky new feature ships platform Off with an override On for the pilot organizers (ADR-105: "an override per organizer does the same job" as a beta label).

## Q-480 - Should the view as organizer cover the whole organizer, not one event? (T-712, ADR-520)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** one event per grant, like the edit grant: the smallest read surface, and an admin can open
a grant per event. Revisit if support often needs the organizer's team or alert pages.

## Q-481 - Is one log row a minute per page "every view"? (T-712, ADR-523)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** yes: every page and every player record opened is logged; a page left open and polling
adds one row a minute instead of one every few seconds.

## Q-482 - Should the organizer see that Questify viewed their event? (T-712, ADR-525)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** no, as Dhia decided for support edits (Q-373); the record is Questify's audit log.

## Q-483 - Should player names and contact fields be masked in the view? (T-712, ADR-524)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** no: the view must show what the organizer sees, and the edit grant already shows it; the
view is one event, 15 minutes, no exports, every record logged by id.


## Q-430 - Should a platform admin who also plays be exempt from maintenance mode? (T-703b, ADR-471)

**Status:** Proposed (developer, 2026-11-03).
The wall holds every player session, including the account of a Questify admin or operator who plays (T-204). The console, the dashboard and the operator doors are never held.
**Recommended (developer):** no exemption: a pause that some accounts ignore cannot be tested honestly, and the admin's real work is not held.

## Q-431 - Show the maintenance message where a refused door answers? (T-703b, ADR-471, ADR-473)

**Status:** Proposed (developer, 2026-11-03).
The server answers 503 `maintenance` with the message, and the app shows the message on Home and under the event pill; a refused scan, join or reservation still shows the generic "try again" text because the screens do not read the code. Every door that earns or spends is held, votes included (surveys, shares, quizzes, submissions, game rounds, taps, meets, the kiosk, and the station's scan, award and check-in, ADR-471); only quest ratings stay open, since they earn nothing.
**Recommended (developer):** after the first real pause, read `maintenance` in the refusal mapping of the scan and join screens and show its message; a new door that earns or spends goes into `PLAY_DOORS`, which `test/security/maintenance-doors.int.test.ts` enforces.

## Q-432 - More than one banner, or a banner for one event? (T-703b, ADR-470)

**Status:** Proposed (developer, 2026-11-03).
FR-1772 asks for one scheduled banner on Questify Home. The block holds one banner; a second replaces the first, and an event's own announcements (T-505) already reach that event's players.
**Recommended (developer):** keep one banner for v1.

## Q-500 - Should Questify switching a feature Off for an organizer also stop running boosts and goals? (T-711b, ADR-540)

**Status:** Proposed (developer, 2026-11-03).
Today the platform switch stops new boosts and goals only; the owner's event switch stops running ones too (ADR-233, ADR-226). **Recommended (developer):** no; the override behaves as the platform switch. A boost ends within a day. A boost saved before the layer went Off still pays when its window opens, without its "boost started" push. With the layer Off the dashboard hides the event's boosts and community switches, so the owner cannot switch the feature off (which would stop every boost at once); Stop on the Boosts page still ends one running boost (`end_boost` has no switch check; a test holds it), and a scheduled one can be deleted until a minute before its start.

## Q-501 - Should admins be told of a new Ask Questify request? (T-711b, ADR-545)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** not in T-711b; the console home's Requests list shows open requests first. An email or a count badge can follow once there is volume.

## Q-502 - May an editor, not only the owner, send Ask Questify? (T-711b, ADR-545)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** owner only, as only the owner switches features.

## Q-503 - May the owner withdraw a pending Ask Questify request? (T-711b, ADR-545)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** no withdraw in v1; an admin declines a request that is no longer wanted.



## Q-490 - Should a running promotional group push be stoppable? (T-706b, ADR-531)

**Status:** Proposed (developer, 2026-11-03).
A promotional send writes its notices a page of 500 players at a time and the store sends them; once sent, a push cannot be
recalled. The console confirms with the reach first and holds sends to 10 an hour per admin, but there is no stop.
**Recommended (developer):** not for v1; add a Stop that ends the send (no more pages) and expires its queued sends if the first
real send shows the need.

## Q-491 - Should a platform push to an event ignore the organizer's "announcements off" default? (T-706b, ADR-532)

**Status:** Proposed (developer, 2026-11-03).
The event push uses the `announcements` topic, so a player's mute and an organizer's default (T-510) both apply.
**Recommended (developer):** keep it: an organizer's choice to silence announcements for their event is respected. A message
that must always arrive (a safety notice) is a different kind, decided when one is needed.

## Q-492 - Should a player capped on push this week be invited by SMS instead? (T-706b, ADR-534)

**Status:** Proposed (developer, 2026-11-03).
`invitation_candidates` leaves a push-ready player out for the week when a group push told them, and does not offer them an SMS.
**Recommended (developer):** no: one promotional message a week per player is the point of the cap; revisit with T-706c, when
SMS and email campaigns share it.

## Q-493 - Does a promotional push count players with no registered phone? (T-706b, ADR-531)

**Status:** Proposed (developer, 2026-11-03).
The audience is read through `marketing_audience`, which does not look at devices, so an opted-in player with no signed-in
phone is counted and gets the center row only (the invitation by push, by contrast, chooses players with a pushable phone).
**Recommended (developer):** keep it: the player agreed to promotional push, and the center is the record of every message.
If the count looks too high against real sends, the console can show the pushable share beside it.

## Q-510 - Should the feature usage page filter by feature and state? (T-714, ADR-550)

**Status:** Proposed (developer, 2026-11-03).
The page lists organizers by name. "Everyone with Cheers off" or "everyone who has the shop on and never used it" would be a filter on a feature and a state, and needs the layer rules in SQL for a keyset page (or a read of every organizer).
**Recommended (developer):** wait until the list passes a few dozen organizers, then add the filter in the door with a parity test against `featureUsageOrganizer`.

## Q-511 - Should "used" count player activity instead of set-up rows? (T-714, ADR-551)

**Status:** Proposed (developer, 2026-11-03).
Today "used" is a row in the feature's table (a map, a reward, a ticket). A shop with rewards and no redemption, or a poll nobody voted in, still counts.
**Recommended (developer):** keep set-up rows for v1; if the team needs "who actually plays with it", add per-event activity counts as a separate, indexed read after the first real events.

## Q-540 - Should the migration runner give every file a default lock timeout? (T-022, ADR-580)

**Status:** Decided (developer, delegated by Dhia, 2026-11-03, after the T-022 code review): yes. The runner sets `SET LOCAL lock_timeout = '10s'` after `BEGIN` in every attempt; a file's own setting overrides it (test in `migrate-retry.int.test.ts`).
The runner retries a lock timeout (55P03), but a file only raises one when it sets `lock_timeout` itself (0063 to 0065 do). A file that sets none waits on a lock for as long as the other session holds it, and every request that queues behind that wait is held too.
**Recommended (worker):** have the runner run `SET LOCAL lock_timeout = '10s'` after `BEGIN` in every attempt (a file's own `SET LOCAL` overrides it), in a small follow-up before the first real players. It changes nothing on an empty database, so no test database is affected, and it makes the retry cover the common case, not only the files that opted in.

## Q-530 - Should a souvenir's sponsor label freeze when the souvenir is activated? (T-507c, ADR-570, ADR-571)

**Status:** Proposed (developer, 2026-11-03).
Today the label follows the tag: an organizer can re-tag, rename or delete the sponsor and every owner sees the change. A frozen label would be a promise like the souvenir's name, audience and art, which an active rule cannot change.
**Recommended (developer):** follow the tag for v1 (the label is private to the owner and the organizer may correct a wrong sponsor). If an owner or a sponsor complains that a label changed after an event, freeze the sponsor id on the rule at activation and keep the tag editable only while the rule is a draft.

## Q-531 - Should the Souvenirs form also pick the sponsor? (T-507c, ADR-570)

**Status:** Proposed (developer, 2026-11-03).
The tag is set from the Sponsors page (one editor for quests, categories, rewards and souvenirs); the Souvenirs page shows a "Presented by" badge on a tagged card.
**Recommended (developer):** keep one place to set it. Add a select to the souvenir form only if organizers look for it there.

## Q-532 - May a player's shared recap image carry the sponsor's name? (T-507c, ADR-571)

**Status:** Proposed (developer, 2026-11-03).
The recap card (ADR-339) is an image the player may share; with a tagged souvenir it now shows "Presented by {sponsor}" under the souvenir's name. The organizer chose to present the souvenir and the player chooses to share, but a sponsor never agreed to appear on a card.
**Recommended (developer):** keep it, since it is the point of FR-1303 for souvenirs. If a sponsor objects, add an organizer switch "Show the sponsor on the recap card" (default on).

## Q-520 - Which phone number is the reviewer's? (T-710, ADR-560, ADR-561)

**Status:** Proposed (developer, 2026-11-03).
The fixed code works for one Saudi mobile number. While a review window is open that number gets no SMS, so a real person holding it could not sign in; while it is closed, codes go to it by SMS.
**Recommended (developer):** a SIM Questify owns (a company line Dhia keeps), entered on the console's review demo page before the first submission (T-806). Not needed to build T-710.

## Q-521 - One reviewer account for Apple and Google, or one each? (T-710, ADR-562)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** one: both reviews can share progress harmlessly, and Prepare resets it before each submission. A second account needs a second number and window.

## Q-522 - Reset the reviewer per build from the console, or automatically on the app version? (T-710, ADR-564)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** from the console's Prepare for review: an automatic reset at the first sign-in of a new version would wipe the level 3 pre-played for the gem shop (T-806).

## Q-523 - May the reviewer change the account's phone number? (T-710, ADR-562)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** no: the app says a demo account's number can't be changed. Allowing it would send a real code to a stranger's number and move the fixed number. Revisit if a reviewer flags it.

## Q-524 - How long is a review window? (T-710, ADR-561, ADR-564)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** 14 days by default, 1 to 30 allowed: a review takes one or two days, and a rejection and resubmission usually fit in 14. A shorter window allows fewer guesses (at most 420 in 14 days).

## Q-525 - Should the demo organizer be left out of platform usage figures? (T-710)

**Status:** Proposed (developer, 2026-11-03).
**Built:** left out of the usage list, feature usage and the numbers page (batch 13, batch 14, migration 0168).
**Recommended (developer):** yes, where a platform total is shown (usage, feature usage, KPIs), in a follow-up; for v1 the console names it "Questify Review Demo", which tells it apart. T-710 build: recorded in `docs/FOLLOWUPS.md` (`console_feature_usage` is not restated in 0144).

## Q-526 - Should the demo content be seeded by a script? (T-710, ADR-568)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-568 accepted. Was: Proposed (developer, 2026-11-03).
**Recommended (developer):** not now: the admin builds it once in the dashboard and the readiness list shows what is missing. If staging and production drift, or each new quest type needs manual upkeep, write a seed that calls the doors the dashboard uses.


## Q-550 - Should a join link play the intro before the join card, as the brief said, or after the join as ADR-096 says? (T-802, ADR-590)

**Status:** Proposed (developer, 2026-11-03).
The task brief for T-802 said "arriving from a join link shows the intro tailored to joining that event, then lands on the join card". ADR-096 (Accepted by Dhia) and FR-1801 say the event preview and join come first, then the intro, then the event. The build follows ADR-096.
**Recommended (developer):** keep ADR-096: the join card is the first thing a player on a venue network needs. If Dhia prefers the intro first, change `afterJoinRoute` and the join entry (one function and one redirect in `app/join/[code].tsx`).

## Q-551 - Should an admin be able to hide or reorder the intro's cards? (T-802, ADR-593)

**Status:** Proposed (developer, 2026-11-03).
FR-1803 (Should) asks for it; T-802 delivers the texts through the translation matrix and T-802b would add the platform setting, the door and the console page.
**Recommended (developer):** build T-802b only if an admin asks to hide a card. The texts can already be reworded, and a card that is wrong for an event type can be reworded instead.
**Update 2026-11-03:** built as T-802b (ADR-610 to ADR-613, `/console/intro`, migration 0145), queued by the coordinator ahead of any request.

## Q-552 - Which art should the intro cards carry now the mascot is chosen? (T-802, ADR-594, Q-069)

**Status:** Proposed (developer, 2026-11-03). The mascot question is settled: Q-069 was decided by ADR-130 (Saqr, the falcon explorer). What waits is Saqr's art, not a choice.
The cards use the app's existing 3D icons. ADR-096 asked for the mascot with animation.
**Recommended (developer):** swap the four images in `IntroArt.tsx` for Saqr's poses once they are drawn; nothing else in the intro changes.

## Q-560 - Where does the API's telemetry go, and who runs the store? (T-018, ADR-600)

**Status:** Decided by Dhia (2026-11-03, AskUserQuestion): CranL `riyadh-1` — a collector, a Prometheus-compatible store and Grafana as CranL apps, data stays in Saudi Arabia; built in T-018b (the same day merged into one monitoring app with no collector, ADR-626, after Dhia capped CranL at three apps).
The API sends metrics and traces over OTLP/HTTP when `TELEMETRY_EXPORTER=otlp`, and nothing until then. Telemetry carries no personal data (ADR-603), so it could go anywhere, but the platform keeps data in Saudi Arabia by default.
**Recommended (developer):** one small CranL service in `riyadh-1` running the OpenTelemetry Collector with a Prometheus-compatible store (VictoriaMetrics) and its rule evaluator, plus Grafana for dashboards; the API's `OTEL_EXPORTER_OTLP_ENDPOINT` points at it over the private network. It costs one small instance, keeps everything in the region, and takes the rules file as it is. A hosted store (Grafana Cloud) is the alternative if running one more service is not wanted; nothing in the API changes. Built in T-018b.

## Q-561 - Who is paged, by what, and what watches from outside? (T-018, ADR-600, ADR-604)

**Status:** Decided by Dhia (2026-11-03, AskUserQuestion): alerts go to Dhia by email (the sending address for now) until there is an on-call team; built in T-018b.
ADR-079 says alerts go to the on-call phone and email and the team is three or more people. The alert rules mark each alert `page` or `warning`. A monitor on the same machine as the API cannot report that machine's death, and the server's own count cannot see a broken certificate or DNS record.
**Recommended (developer):** Alertmanager (or the store's own routing) sends `page` alerts to email and a phone push or SMS to the on-call person of the week and `warning` alerts to email; an outside uptime check of `/readyz` from two places (a free tier of an uptime service is enough) pages independently of our own stack. Who is on call, and the numbers, are Dhia's to give. Built in T-018b.

## Q-562 - Are the first alert thresholds right? (T-018, ADR-604)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-604 accepted. Was: Proposed (developer, 2026-11-03).
The numbers in `ops/alerts/questify.rules.yml` come from ADR-074 (99.9%, 1 s at the 95th percentile) and from common practice (burn-rate windows, 20% failure for a provider, 5 minutes for a loop). The ADRs give no target for SMS, push or email delivery.
**Recommended (developer):** keep them until the load test (NFR-003) and the first real event, then read the month's alert history and the metrics together and change only what paged for no reason or stayed quiet through a problem. Edit the rule, run `promtool test rules`, and note the change in SLO.md.

## Q-570 - May the intro read the public configuration? (T-802b, ADR-611, FR-1800)

**Status:** Decided by the developer (delegated by Dhia, 2026-11-03, after the T-802b code review): yes, the intro makes one `GET /v1/config`; the plain client sends the install id, language and app version, which the server ignores on this route (STORE_COMPLIANCE, ADR-611 and FR-1800 say so).
FR-1800 says the intro asks for no permission and collects no data; T-802 went further and made it request-free, with a test that fails on any network use. The platform's card order (FR-1803) cannot reach a first launch from the cache, because the phone has none yet.
**Recommended (developer):** allow the one anonymous `GET /v1/config` read the app already makes on Home (no sign-in, nothing about the player), bounded to 1.5 seconds, with the shipped four as the fallback. If Dhia wants an intro that makes no request at all, drop `resolveIntroOrder` and play the cached order only (replays) or the shipped four.

## Q-571 - Should the join welcome card still show when an admin hides the join card? (T-802b, ADR-612)

**Status:** Proposed (developer, 2026-11-03).
**Recommended (developer):** no: it is the join card's variant and follows it. If the event's name should always be said after a join, make the welcome a fixed first card instead and keep the four editable cards after it (`introCards` in `apps/app/src/onboarding/intro-flow.ts` is the one place).

## Q-580 - Which CranL facts must the first deploy of the monitoring app confirm? (T-018b, ADR-622, ADR-626)

**Status:** Proposed (developer, 2026-11-03). Needs a person with the CranL account; no answer from Dhia, only the result.
The files were built from CranL's public documentation without calling CranL. Five things they assume (ADR-626 left the old assumption about apps reaching each other: there is one app): (1) a Dockerfile path inside a folder builds with that folder as its context (the web app's note says so); (2) a volume on `/data` is writable by the user `grafana` (uid 472) of the image, which the Dockerfile sets as the owner of `/data` (if the mounted volume is owned by root, set the owner as CranL's volume page says); (3) the app's public address passes `POST` bodies of up to 4 MB and the request header `Authorization` unchanged through CranL's CDN, and keeps the `Host` header (Grafana's login checks it against `GF_SERVER_ROOT_URL`); (4) CranL gives the app the port it is told (8080) and ends TLS in front of it; (5) the container may use about 1 GB of memory (Grafana alone takes 300 to 400 MB).
**Recommended (developer):** make them the first checks when the staging stack is created (RUNBOOK, "After the first deploy"), record the answers here, and close the question.

## Q-581 - Which SMTP account sends the alert mail? (T-018b, ADR-624)

**Status:** Decided by Dhia (2026-11-03): no alert email for now; dashboard only; reopen when a sender (Gmail app password or Resend key) exists.
Earlier the same day Dhia chose to reuse the sign-in Gmail account; that stays the preference for when a sender exists, but Alertmanager needs an SMTP login, which the API's Gmail service account is not. Built: with `ALERT_SMTP_HOST` unset or empty the monitoring app runs in a no-email mode (RUNBOOK, "Monitoring stack on CranL"); setting the five `ALERT_*` settings turns email on with no code change.
Alertmanager speaks SMTP; the API's own sender is the Gmail API (a service account), which Alertmanager cannot use. Options: (A) Resend SMTP, `smtp.resend.com:587`, user `resend`, a send-only API key made for alerts, From an address on a domain verified in Resend; (B) Gmail SMTP, `smtp.gmail.com:587`, an app password of the sending mailbox (needs 2-Step Verification, and Google does not recommend app passwords); (C) Google Workspace SMTP relay, `smtp-relay.gmail.com`, which wants an admin setting and a fixed address CranL may not give.
**Recommended (developer):** (A), because the account and the verified domain already exist for the API's backup sender (`RESEND_API_KEY`), a separate key can be revoked alone, and it needs no admin setting. Until a sender exists the stack runs in the no-email mode: rules are evaluated, firing alerts show on the Grafana dashboard, nothing is sent.

## Q-582 - One monitoring stack per environment, or one for both? (T-018b, ADR-620)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended. Was: Proposed (developer, 2026-11-03).
The rules add up every instance and have no environment label, so a shared store would mix staging and production. A stack is one app since ADR-626 (Dhia: at most three apps on CranL, the API, the web app and one monitoring app).
**Recommended (developer):** one monitoring app per environment: staging now, production's own copy of the same folder when production exists. If the application slots run short, run one app and add a `deployment.environment.name` matcher on every rule and test, and promote that resource attribute with `otlp.promote_resource_attributes` in `prometheus.yml` (a day of work, and `deployment.environment.name` is the Node environment, `production`, on staging too, so a new setting is needed first).

## Q-583 - Where do traces go? (T-018b, ADR-623)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended. Was: Proposed (developer, 2026-11-03).
The API can send spans (a share, `TELEMETRY_TRACE_RATIO`), and its logs carry `trace_id`. Prometheus stores no traces and has no trace endpoint (it answers 404, tested), so the API must run with `TELEMETRY_TRACE_RATIO=0` (with `TELEMETRY_EXPORTER=otlp` that is the default; the default for the other exporters is 0.1).
**Recommended (developer):** nowhere yet; set the ratio to 0. Add Grafana Tempo (one binary, local disk, 7 days, a second volume; inside the monitoring container, because of the three-app cap) the first time an incident needs to follow one request, and point the API's trace export at it. The web app's traces joined to the API's (T-018b item 8) wait for the same.

## Q-584 - What watches the monitoring stack from outside? (T-018b, ADR-624)

**Status:** Proposed (developer, 2026-11-03). Needs an account only Dhia can open.
If the Prometheus app or its Alertmanager is down, or the SMTP login is wrong, no alert says so; `QuestifyTelemetryMissing` covers a silent API but needs the stack itself. T-018b item 3 (an outside probe of `/readyz`) is still open for the same reason.
**Recommended (developer):** a free uptime service that probes `/readyz` of the API and the monitoring app's address from two places and emails or messages Dhia, plus a daily "dead man's" heartbeat: an always-firing rule posted to the service, which mails when the heartbeat stops. Dhia chooses the service and opens the account; the rule and the receiver are one block each in `ops/alerts/` and `alertmanager.yml.in`.

## Q-585 - Add a second wall for the closed list of attributes inside the API? (T-018b, ADR-626)

**Status:** Decided by the developer (2026-11-03): yes, built. `installTelemetry` gives the meter provider one view (`instrumentName: "*"`) whose attributes processor is `safeAttributes`, so keys off the list and values out of their shape are dropped inside the SDK before export; `sdk.test.ts` proves it through the real SDK and fails without the view (ADR-626 item 7).
With the collector gone, the closed list (ADR-603) is enforced once, by `safeAttributes`, because Prometheus cannot drop attributes it is sent (ADR-626 item 7). The collector used to delete anything off the list again.
**Built (developer):** one OpenTelemetry view on the API's meter provider in `installTelemetry` (`apps/api/src/telemetry/sdk.ts`): `views: [{ instrumentName: "*", attributesProcessors: [{ process: (incoming) => safeAttributes(incoming) }] }]`. It uses `safeAttributes` rather than a key allow-list so the second wall also holds the value shapes (a route with a phone number in it is dropped, not only an off-list key); the resource keeps its four keys (`RESOURCE_KEYS`). Four tests in `sdk.test.ts` (counter, histogram and observable gauge recorded without `safeAttributes`; an off-shape value; the real instruments keep their buckets and attributes; the resource keys) run through the real SDK with an in-memory exporter, and the first three fail with the view removed.

## Q-590 - Check the seat limit once per statement, or keep a seat counter? (T-221, ADR-630)

**Status:** Answered (developer, delegated by Dhia, 2026-11-03, after the T-221 code review 92): statement-level check, ADR-630; answers Q-323.
**Recommended:** a statement-level check (AFTER statement triggers with transition tables, ADR-630): one count per statement, no stored state, every writer covered. **The other option:** a seat counter on the event kept by the same writes: O(1) free seats on every join, but it must stay right across every path that seats or frees a player (joins, the player's own leave in TypeScript, erase, the rehearsal wipe, the review-demo seed, admin direct writes), needs a backfill and a reconciliation check, updates one hot row 5,000 times in an accept-all (a growing version chain inside one transaction), and serialises joins on events without a limit. Revisit only if a join-rush profile shows the per-join count.

## Q-591 - How many requests may one accept-all call take? (T-221, ADR-631)

**Status:** Answered (developer, delegated by Dhia, 2026-11-03, after the T-221 code review 92): 1,000 a call in both modes, ADR-631.
**Recommended:** up to 5,000 a call in both modes, the dashboard repeating above that. **Measured at build (2026-11-03): 5,000 took 14 to 29 s, so the cap is 1,000 in both modes (2.78 s median on the fixture), ADR-631.** Getting near 5,000 needs the welcome grant's per-row cost lowered first (FOLLOWUPS). **Other options:** truly unbounded (a large queue is refused by the 5 s limit and accepts nothing); keeping 1,000 without a limit and the free seats with one (two numbers for no gain).

## Q-600 - How does the review picker give the reviewer a meet code, and does it list NFC tags? (T-710b, ADR-640)

**Status:** Answered (developer, delegated by Dhia, 2026-11-03, after the T-710b code review 87): ADR-640.
**Recommended:** a separate `POST .../review-codes/meet` that issues a fictional player's pass when picked, and no tag entries: a tag quest is reached through its quest QR (ADR-640). The code review (87) found a picked tag, sent with no chip id, is recorded on Android as a copied tag (`nfc_copy`), so the tag entries were dropped. **Other options:** issue a pass for every meet quest inside the GET (a read that writes, passes that expire before they are picked); send tags with a `uidReason` the server trusts for the reviewer (a new path around the copy check); leave meet quests out (the reviewer could not reach a quest type, against Apple 2.1).

## Q-610 - The staging monitoring app builds from a folder that no longer exists (T-017, ADR-626, ADR-650)

**Status:** Open (developer, 2026-11-04). Needs Dhia: a dashboard step.
`plan staging` (read-only, 2026-11-04) matched every setting of the API, the web app and both databases, and found one difference: the monitoring app `questify-prometheus-staging` (created under the three-app design, before ADR-626) builds from `/ops/monitoring/prometheus`, which ADR-626 replaced with `/ops/monitoring/stack`, and the app is `stopped`. A public-repo app's build folder can be changed only in the CranL dashboard. Its name keeps the old `prometheus` word; renaming means a delete and a create, and a deleted app holds its slot for 7 days, so the file keeps the name.
**Update 2026-11-06 (Dhia; the plan failed, Q-610 stays Open):** CranL refused `PUT /apps/{id}/source` on `questify-prometheus-staging` (a `public_repo` app: "unsupported"), and `plan: true` had passed without checking that. Dhia created `questify-monitoring-staging` (id `24b87cd2-f985-4db3-a1fd-18f9d75ac108`) from `/ops/monitoring/stack`, with a `monitoring-data` volume on `/data` and a new metrics password held only in CranL settings, set the API's `TELEMETRY_*` and `OTEL_*` settings and restarted `questify-api-staging`. Metrics arrive, 20 rules are loaded, `/-/healthy` and OTLP answer 401 without the password, `/readyz` is 200, alert email is off (Q-581). `ops/cranl/staging.json` and the docs now name the new app (ADR-812, Proposed). **Not closed:** three checks wait until the CranL key covers the new app (it gets 403 today): why CranL shows "deploying", that `/data` survives a redeploy, and Grafana sign-in; and `plan staging` must show no differences. The old app stays stopped until Dhia deletes it (4 apps against the limit of 3 until then).
**Original recommendation (superseded by the update above):** Dhia sets the app's build folder to `/ops/monitoring/stack` (Dockerfile path `Dockerfile`) in the dashboard and redeploys it; then `plan staging` shows no change, and the API's `TELEMETRY_*` settings are added to `ops/cranl/staging.json` and applied (RUNBOOK "Pointing the API at it"). The metrics password was made by the first setup script, so it must be supplied as `SECRET_MONITORING_METRICS_PASSWORD` (or rotated) for the API's `OTEL_EXPORTER_OTLP_HEADERS`.

## Q-611 - Staging PostgreSQL backups have never succeeded (T-017)

**Status:** Deferred (Dhia, 2026-11-04: "Later"): asked at the CranL go/no-go, T-811.
CranL's backup schedule for `questify-db` (created 2026-10-19) is on, daily at 00:28 UTC, keeping 7, but on 2026-11-04 it reported no successful run, no failure, and no kept backup (`last_success_at` and `last_failure_at` empty, `kept_count` 0). Staging holds fake data only, but production will use the same schedule.
**Recommended (developer):** after the next scheduled run, read `GET /databases/{id}/backups` and the policy again; if still empty, take one manual backup (`POST .../backups`) and ask CranL support why the schedule does not run. Production does not open before one backup is restored on a copy (T-019, T-811).

## Q-612 - Which CranL settings stay outside the files? (T-017, ADR-650)

**Status:** Answered (developer, delegated by Dhia, 2026-11-04, after the T-017 code review 88): the named exceptions in ADR-650.
The CranL API cannot read some settings, so the files can set them at create but `plan` cannot see them drift: the Dockerfile path, the app's automatic rollback, and the health-check path (the RUNBOOK names `/en/sign-in` for the web app; there is no API field). A public-repo app's build folder and branch can be read but changed only in the dashboard.
**Recommended (developer):** accept these as the named exceptions to "no setting only in the dashboard": the RUNBOOK lists them with the values to check by hand after a create, and `plan` reports a build folder or branch change as a manual step. Revisit when CranL's API adds them (its OpenAPI is at `https://app.cranl.com/api/v1/openapi.json`).

## Q-613 - When may production be created on CranL? (T-017b, ADR-626, ADR-650)

**Status:** Answered (Dhia, 2026-11-04: "Skip the proof"): no scratch environment; production is created at launch from the same RUNBOOK steps.
`ops/cranl/production.json` declares production (three apps and two databases, daily backups at 03:00 Riyadh time keeping 30, the API sending telemetry to its own monitoring app, Q-582). The account is at its plan's limit of 20 apps and databases, and Dhia capped Questify at three apps and two databases (ADR-626). Creating production, or proving a fresh environment on a scratch copy, needs five free slots.
**Recommended (developer):** decide whether production is three more apps and two more databases (the cap read per environment) or shares staging's slots; then run T-017b (RUNBOOK "Infrastructure as code on CranL", "A fresh environment").

## Q-620 - The completion path is about 40 times too slow for NFR-003 at ten events (T-804, ADR-660)

**Status:** Open (developer, 2026-11-04). Needs a tier A task; no product choice for Dhia.
Measured on the dev PC (Ryzen 7 1700, 8 cores and 16 threads, 48 GB, Windows 10, Docker PostgreSQL 17.11, one API
with a pool of 10, 10 events of 2,500 players and 20 quests): the most that meets NFR-002 is about **80 completions a
second for all ten events together** (p95 245 ms, ranking p95 253 ms after the confirm); 95 a second fails (p95 1.65 s),
110 fails (p95 6.8 s), and the target 3,333 a second collapses (16 of 149,504 confirmed within the app's 15 s; 1,626
written). PostgreSQL is the limit: 6 to 7 of its cores busy at 80 to 110 a second (about 60 to 90 ms of database CPU per
completion), while the API used 0.5 to 0.7 of one core and the client's own delay stayed at 14 ms p95. A pool of 30
moved PostgreSQL to 10.5 cores and still failed at 110 a second (p95 2.6 s). Where the time goes
(`pg_stat_user_functions`): `own_bonus`, `ranking_day_entry_of`, `own_level`, `ranking_eligible`, `own_quest_item`,
`own_first_bonus`, `period_count` and the sign-in check `player_session_owner`, each 1 to 5 ms a call. They are
`LANGUAGE sql` functions with `SECURITY DEFINER` or `SET search_path`, which PostgreSQL 17 cannot inline and plans
anew on every call: `own_bonus` took 2.5 ms a call as written and 0.08 ms as the same query in `plpgsql` (plan cached),
on an idle server. The schema has 494 `LANGUAGE sql` functions, 141 of them `SECURITY DEFINER`. On PostgreSQL 18.6
(which caches plans for SQL functions; tried in a throw-away container, removed afterwards) the same code used about
45% less database CPU: 110 a second gave p50 110 ms but p95 1.7 s, and 160 a second needed two API processes to reach
93% within 1 s, where the single API process reached 87% of one core. A related finding: an overloaded API keeps
working on requests whose phone has already given up, so points are granted after the app showed a failure (the
idempotency key returns them on a retry); there is no load shedding before the database pool.
**Recommended (developer):** a tier A task before the production-like rerun: (1) rewrite the completion path's hot
functions (the list above, plus `complete_quest`'s other `LANGUAGE sql` callees) as `plpgsql`, in a new migration, with
the ledger's tests unchanged; (2) find out CranL's PostgreSQL major version and ask for 18 if it is 17; (3) cut the
completion's round trips (about 12 statements after `complete_quest`, each on the held connection) by returning the
answer's parts from `complete_quest` itself; then rerun T-804 locally (`node ops/load/run.mjs`) before the
production-like run. Even at PostgreSQL 18's cost, 3,333 a second needs roughly 130 database cores, so (1) and (3) are
needed whatever the hardware. **Other options:** more hardware alone (does not reach the target); lowering NFR-003 to
the measured figure (a product change for Dhia, not recommended before the rewrite is measured).

## Q-621 - The sign-in rush: one platform lock, one address window and the SMS budget (T-804, T-107, Q-093)

**Status:** Open (developer, 2026-11-04). Part (3) is Q-093's choice for Dhia.
Measured with the SMS sender stubbed (as the tests do), new phones, 50 codes per client address, one API: every
`POST /v1/auth/code` takes the platform budget's advisory lock inside its transaction, so codes are sent one at a time
across the whole platform. 25, 50 and 100 a second answered 202 with p95 43 ms, 37 ms and 297 ms; 120 a second p95 2.3 s,
150 a second p95 5.6 s, 175 a second p95 9.4 s (every request 202, just late). The ceiling is about **100 codes a second
for the whole platform** (6,000 a minute) on this PC. Two rules then bite at an event's opening: (1) all 250 codes from
one client address were tried at 50 a second and the 201st was refused (429): a venue's Wi-Fi or a carrier's shared
address lets 200 people an hour sign in by SMS; (2) the platform's 5,000 SMS an hour (Q-093) is a quarter of ten
events' 25,000 players, the rest are offered email.
**Recommended (developer):** (1) replace the per-request platform lock with a counter the database updates without
holding a lock across the transaction (one `UPDATE ... RETURNING` on a per-hour row, or a sequence per hour), so codes
are limited by the budget, not by one lock; (2) raise the per-address window for players to about 2,000 an hour (the
per-number and per-install windows still stop pumping), and keep the staff one; (3) settle Q-093's platform budget from
the largest booked day before the first ten-event day. Measure again with `--skip-completions` after (1) and (2).

## Q-630 - What can CranL's database offer for the completion load? (T-804a, ADR-670)

**Status:** Deferred to T-811 (Dhia, 2026-11-04: "Later"; asked at the CranL go/no-go). Nothing to buy now.
After T-804a a completion is expected to cost about 10 ms of database CPU on a dedicated server (12.4 ms measured with
only the plpgsql rewrite, idle) and about 6 to 7 ms of Node CPU. To size the production-like rerun and NFR-003 x NFR-025
we need from CranL: the largest PostgreSQL plan (vCPU, memory, `max_connections`, which must cover API processes x 13),
whether PostgreSQL 17 or 18 is offered and how a major upgrade runs (18 caches SQL-function plans itself, about 45% less
CPU in T-804's try), whether read replicas exist, and the round-trip time between an app and its database in
`riyadh-1`.
**Recommended (developer):** ask CranL these points before the production-like rerun; stay on 16.15 until then.

## Q-631 - 3,333 completions a second needs more than one database (NFR-003, NFR-025; T-804a)

**Status:** Answered (Dhia, 2026-11-04: "Size to real bookings"): the launch target is set from the biggest event day
actually booked, not 20,000 a minute in each of ten events at once; the code is made fast now (T-804a) and the hardware
is scaled when bookings need it. Option (c) below; (a) is designed only when bookings need it.
Ten events at 20,000 completions a minute each is 3,333 a second. After T-804a that is roughly 35 to 130 database cores
on one primary (about 10 ms a completion on a dedicated server, 25 to 40 ms measured on the loaded dev PC) and about 25
API processes. Code changes reach about 240 a second on the dev PC, not the target. Ways to it: (a) split events over
several database primaries (an architecture change); (b) move parts of a completion (XP, streaks, souvenirs, flags) out
of its transaction (changes what the answer can say at once); (c) set NFR-003 x NFR-025 from the largest booked day
(for example 20,000 a minute in one event and a lower sum across ten).
**Recommended (developer):** (c) for launch, with the figure measured after T-804a and the production-like rerun; (a)
designed only when bookings need it.

## Q-632 - Tests run on PostgreSQL 17 while CranL staging runs 16.15 (T-804a)

**Status:** Open (developer, 2026-11-04).
CI, the local tests and Stryker use `postgres:17-alpine`; staging runs 16.15. On 2026-11-04 all 147 migrations ran
cleanly on a 16.15 container and the completion path behaved the same, but nothing checks this on each change.
On 2026-11-04 (T-804a part A) migration 0148 and its parity test, with the completion engine, XP, streak and ranking
suites (121 tests), passed on a throw-away 16.15 container.
**Recommended (developer):** move CranL to 17 when it offers it (Q-630); until then run the DB suites on 16.15 locally
once before each deploy that carries migrations (a RUNBOOK step), not as a second CI job.

## Q-633 - Load shedding before the database pool (T-804, T-804a)

**Status:** Open (developer, 2026-11-04).
T-804 found that an overloaded API keeps working on completions whose phone has already given up (15 s), so points are
granted after the app showed a failure (the idempotency key returns them on a retry). Nothing refuses work before the
pool.
**Recommended (developer):** a later tier A task: answer 503 with `Retry-After` when a request has waited more than
about 2 s for a pool connection, before the engine runs; measured with the T-804 harness.

## Q-634 - The sign-in address window: per platform or per event? (T-804b, Q-621)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended. Was: Open (developer, 2026-11-04).
Raising the player per-address window to about 2,000 an hour (Q-621) serves one venue; ten venues behind one carrier
address would share it.
**Recommended (developer):** one platform window of about 2,000 an hour in T-804b, then measure; a per-event window needs
the event before sign-in, which the code request does not carry.

## Q-640 - Do the other completion doors get a one-statement answer too? (T-804c, ADR-680)

**Status:** Answered (developer, delegated by Dhia, 2026-11-04): as recommended, the other doors stay on `afterCompletion` until a profile shows one on a booked event's peak.
Only `POST /v1/quests/:questId/complete` (QR, typed code, check-in, screen code) uses `complete_quest_answer`. The NFC
tap, the plays (quiz, vote, game, passport, meet, survey, share), submissions, the kiosk and the operator scan still read
their parts one call at a time and their ranking through `afterCompletion` (two more transactions).
**Recommended (developer):** leave them until a profile shows one of them on a booked event's peak; a scan at the gate
is the rush, the others are spread over the day.

## Q-641 - The 10 ms of database time a completion is not reached (T-804c, ADR-674)

**Status:** Answered (developer, delegated by Dhia, 2026-11-04): as recommended; it is task T-804e.
T-804c cut the round trips (20 to 5) but not the work: on one throw-away PostgreSQL 17.11, 10 completions a second
through the T-804 drivers, the statements of a completion took about 23.5 ms before and after (`complete_quest` 14.7 ms,
of which the ledger insert and its triggers 8 ms: `xp_credit` 3.2, `streak_record` 1.5). T-804a's one-at-a-time
profile had measured 10.9 ms on another container; the two methods disagree by about 2x on the same function.
**Recommended (developer):** a tier A task that profiles `record_completion` and its ledger triggers with T-804a's
one-at-a-time script committed under `ops/load/`, so the number is reproducible, then decides what to make cheaper.

## Q-650 - The earned address window's numbers and a console screen for the send budget (T-804b, ADR-690, ADR-691)

**Status:** Open (developer, 2026-11-04).
ADR-691's 200 base, 2 per right code and 2,000 ceiling (and 100, 1, 500 for wrong codes) are guesses until a real
event's opening shows how many codes a venue types back. The platform budget is now a row of `platform_send_budget`
changed by an owner `UPDATE` (RUNBOOK); no console screen edits it. A lowered cap settles for one window (ADR-690):
the budget takes one request at a time until then, so lower it outside an event's opening.
Email contacts verify at no cost, so one address can reach the 2,000-an-hour ceiling of ADR-691 on email codes and
drain the 1,000-a-day email budget in under an hour, after which every player's email code is refused until the
window moves on.
**Recommended (developer):** review the numbers after the first booked event, and choose a lower email ceiling
later (not built here); build a console screen only when Dhia
wants to change Q-093's number himself.

## Q-651 - The staff sign-up and invite mail budget keeps its one lock (T-804b)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended. Was: Open (developer, 2026-11-04).
`takeOutboundMail` (`auth/outbound.ts`) still takes one platform advisory lock per sign-up or invite email. It is not
on the player rush path and its traffic is small.
**Recommended (developer):** leave it; move it onto `take_send_budget` only if a measurement shows it waiting.

## Q-652 - The half-budget warning is dropped (T-804b, ADR-690)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-690 accepted. Was: Open (developer, 2026-11-04; plan review of T-804b).
Per stripe, `player.budget_half` would have been logged up to 16 times a window, and no alert read it, so T-804b removed
it: `player.budget_spent` (alert `QuestifySendBudgetSpent`) is the only budget line.
**Recommended (developer):** if a warning before the cap is wanted later, read the channel's total from
`auth_throttle` in a monitoring query rather than in the request path.

## Q-660 - A player's session has no absolute end (T-810, ASVS V7.3.2, V7.1.1)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05): as recommended, a refresh family ends 365 days after its sign-in; built in T-810b (item 9), the reason goes in SECURITY.md.
A player's refresh token lasts 180 days and every rotation issues a new one for another 180 days (migration 0013,
`issue_player_tokens`), so a phone that opens the app at least twice a year stays signed in forever. ASVS 5.0 L2 asks
for an absolute maximum and a written reason for any departure from NIST SP 800-63B's re-authentication times. Staff
sessions already end after 12 hours (admins 8).
**Recommended (developer):** end a refresh family 365 days after its sign-in, whatever its use (one fresh code a year
per phone), and write the reason in SECURITY.md (low-value accounts, a stolen phone ends with sign-out or the 10-family
limit). The alternative is to keep sliding sessions and record that as an accepted deviation.

## Q-661 - Session controls for players and for admins (T-810, ASVS V7.4.3, V7.4.5, V7.5.2)

**Status:** Answered (Dhia, 2026-11-05, "Build it (Recommended)"): task T-810c.
A player cannot see their signed-in phones or end the others; changing a phone or email keeps every session (ADR-120)
and offers no "sign out other devices"; a Questify admin can end only another admin's sessions from the console (an
organizer member's or a player's need SQL from the RUNBOOK; a ban stops a player at once); a staff member ends their
own other sessions without typing anything again.
**Recommended (developer):** one tier A task after launch prep: a "Signed-in devices" list in the app's account screen
with Sign out per device and for all others (also offered after a contact change); a console action that ends every
session of one staff account or one player, with a reason in the audit log; a fresh code before a staff member ends
other sessions. Needs Dhia's yes because it adds screens.

## Q-662 - Players sign in with one factor (T-810, ASVS V6.3.3, V6.6.1)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05): as recommended, one factor is accepted for v1 with the rationale and compensating controls written in SECURITY.md (T-810b); passkeys are revisited after the first events. The line on the code screen: Dhia, 2026-11-05, "Add the line (Recommended)", task T-810e.
Players sign in with one code by SMS or email (ADR-030). ASVS L2 asks for more than one factor, or a documented
rationale with compensating controls, and for SMS codes to come with a stronger option and a note about SMS's risks.
**Recommended (developer):** accept for v1 and write the rationale in SECURITY.md: a player account holds event points
and prizes of small value, never money or a card; the compensating controls are the per-contact and per-install
limits, single-use 5-minute codes, refresh-token theft detection, the handover's accept in the player's own app and
the notices on every contact change. Revisit passkeys after the first events. Telling players about SMS's risks is a
copy choice for Dhia (one line on the code screen).

## Q-663 - The console shares a hostname with public pages (T-810, ASVS V3.5.4)

**Status:** Answered (Dhia, 2026-11-05, "Yes, console subdomain (Recommended)"): task T-810d; Dhia adds the DNS record and the CranL domain.
One web app on one hostname serves the console, the organizer dashboard, the public event page, the station and
kiosk pages and the big screen. A script injected through any public page would run on the console's origin. Today the
CSP with nonces and text-only organizer content are the walls.
**Recommended (developer):** serve the console from its own hostname (for example `console.<domain>`) through the same
CranL web app, so the `__Host-` cookie of the console never reaches the public origin; no new CranL app is needed
(memory: three apps). Needs Dhia to choose and point the hostname.

## Q-664 - Infrastructure controls held by CranL (T-810, T-811; ASVS V4.1.2, V12.1, V12.2.2, V12.3, V13.2, V13.3, V16.4)

**Status:** Deferred (developer, 2026-11-05): with T-811, which Dhia moved to later on 2026-11-04 (Q-630).
These ASVS L2 controls depend on CranL, and none is confirmed: the TLS versions and cipher suites at the edge and its
certificates; whether the API host redirects plain HTTP (it should refuse it); TLS between the web app, the API,
PostgreSQL and Redis on the private network (`DATABASE_URL` carries no `sslmode`, `REDIS_URL` may be `redis://`);
static database and Redis passwords; no egress allowlist; who can read the app settings (the secrets) and whether
that is logged; and server log lines kept only in CranL's log view, with no copy outside the API's host.
**Recommended (developer):** add these to the T-811 questions to CranL. Then require `sslmode=verify-full` and
`rediss://` where CranL offers them, rotate the database and Redis passwords on a schedule written in the RUNBOOK,
and ship log lines to the monitoring app (T-018b) so a breached API host cannot rewrite them.

## Q-670 - Invitation link tokens: 128 or 256 bits (T-810b item 3, ADR-702)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05, after the T-810b code review 92): as recommended.
TASKS.md says 256 bits; ASVS V11.5.1 asks for 128. A 256-bit token is 43 characters instead of 22 in a message held to
3 SMS parts, so every event name in an invitation would be cut about 21 characters shorter.
**Recommended (developer):** 128 random bits in the existing column (no SMS change); choose 256 only if a reviewer
wants margin over the standard.

## Q-671 - Hidden 404s inside definers are not logged as denials (T-810b item 5, ADR-703)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05, after the T-810b code review 92): as recommended.
Row-level security makes another tenant's object look absent inside the database, so only the hook-level hides and the
403s can be named `authz.denied`; logging every authenticated 404 would log every typo and expired link.
**Recommended (developer):** log 403s and the explicit hides; revisit if the pen test (T-809) shows object probing.

## Q-672 - Tag every release so it gets an SBOM (T-810b item 7, ADR-704)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05, after the T-810b code review 92): as recommended.
Releases (CranL deploys, store builds) are started by hand and have no tag today.
**Recommended (developer):** the coordinator pushes `release-YYYYMMDD-N` on the deployed commit each time (RUNBOOK);
a later release script can do it automatically.

## Q-673 - Reward code key rotation moves to T-810f (T-810b item 8, ADR-705)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05, after the T-810b code review 92): as recommended.
The key id touches the config, the seal format, every opener, the upload's duplicate check and a new operator command;
nothing is at risk until a leak forces a rotation.
**Recommended (developer):** build it as T-810f after T-810b, with its own plan review; the sheet's row 8 points there.

## Q-680 - Do players type a fresh code before ending their other devices? (T-810c, ASVS V7.5.2, ADR-711)

**Status:** Answered (Dhia, 2026-11-05, AskUserQuestion: "Yes, ask a code (Recommended)"; INBOX 2026-11-05). Players
type a fresh sign-in code before ending other devices, skipped within 10 minutes of a sign-in or a contact change on
this phone (ADR-711).
Q-661 asked for a fresh code before a staff member ends other sessions; it said nothing for players. ASVS V7.5.2 asks
for it for everyone.
**Recommended (developer):** yes, a sign-in code by SMS or email, except within 10 minutes of signing in on this phone
or changing the phone or email on it (so the lost-phone and contact-change paths need no extra code). Option B: no code
for players (the row stays Partly for players). Option C: a code every time (an SMS on the lost-phone path too).

## Q-681 - How long a fresh factor lasts (T-810c, ADR-711)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05): 10 minutes, as recommended.
**Recommended (developer):** 10 minutes, the life of the staff sign-in code.

## Q-682 - An 11th sign-in racing the oldest family's rotation (T-810c, ADR-717)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05, after the T-810c code review 91: accepted as recommended).
When an 11th sign-in has to wait for the oldest family's rotation, it ends that family once the rotation commits, its
new tokens included, although that phone was just used. No token is left alive and nothing deadlocks.
**Recommended (developer):** accept it: it needs ten other live sign-ins and a rotation in the same moment, and the
phone only signs in again. Re-reading the oldest family after the lock would add a query to every capped sign-in.

## Q-694 - One previous reward code key or a list (T-810f, ADR-725)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05, after the T-810f code review 93: one previous key, as recommended).
**Recommended (developer):** one previous key: two plain settings, no separator parsing, and the re-seal finishes before
any next rotation.

## Q-695 - When the legacy reward code format stops being readable (T-810f, ADR-729)

**Status:** Answered (developer, delegated by Dhia, 2026-11-05, after the T-810f code review 93: per ADR-729: remove the legacy path only after `check` exits 0 on every database and the backups taken before the re-seal have expired).
**Recommended (developer):** after T-810f is deployed, run `reward-codes.cjs reseal` then `check` on staging (and on
production before launch); when both exit 0, a small follow-up removes the legacy path.
**Caveat (plan review 88):** the legacy path may be removed only after every database backup taken before the re-seal
has expired: a restored backup holds legacy rows, which only the legacy path opens.

## Q-696 - Rehearse a reward code rotation on staging (T-810f)

**Status:** Deferred (Dhia, 2026-11-05: "Later"; ask again before the first production rotation).
**Recommended (developer):** yes, once: Dhia sets the four settings of the plan's section 7 in CranL (the new secret
generated there, never sent anywhere), the coordinator runs `reseal` and `check`, then Dhia removes the previous two.
Without it the proof is the integration tests only.

## Q-697 - Is ADR-674's 10 ms judged on first completions? (T-804e, ADR-734)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-734 accepted. Was: Open (developer, 2026-11-05).
The committed profile measures a player's first completion: 10.78 and 10.98 ms. Later completions read a growing
history (the day's ledger sum, the flag trigger's recent scan, the period count) and cost more.
**Recommended (developer):** yes, the gate is the first-completion number; the build also reports
`--quests-per-player 10` before and after, without a limit, and a later rerun on production-like data decides whether
a second gate is needed.

## Q-698 - Fewer foreign keys and an answer built from memory are not done (T-804e plan section 4)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended. Was: Open (developer, 2026-11-05).
Merging the enrollment and event-organizer key pairs into one three-column key saves about 0.25 ms but needs a new
unique index on `enrollment`, keys validated on the biggest tables during a deploy and a weaker guarantee. Having
`record_completion` return the answer's parts saves about 1 ms but changes the engine's shared return type and leaves
two ways to answer.
**Recommended (developer):** neither now; revisit only if the build of section 3 lands above 10 ms or a production-like
rerun needs the time.

## Q-699 - The one-at-a-time profile runs on the shared test container (T-804e, ADR-674, ADR-734)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-734 accepted. Was: Open (developer, 2026-11-05).
ADR-674 kept profiling off the shared container because it had no `pg_stat_statements`. `ops/load/profile.mjs` needs
none: it reads `pg_stat_user_functions` of its own database and loads auto_explain into its own session only.
**Recommended (developer):** allow it there; other sessions' tests share the CPU, so a run taken while the full suite
runs elsewhere is discarded, as T-804a discarded one taken during an image download.

## Q-700 - Key management gaps found while writing the cryptographic inventory (T-810, ASVS V11.1.1)

**Status:** Open (developer, 2026-11-06).
SECURITY.md "Cryptographic inventory and key policy" is written from the code. It shows what is missing; none of it is built:
(1) QUALITY_BASELINE section 4 says secrets are "rotated on a schedule and when someone leaves"; only the monitoring password has a
schedule (every six months, RUNBOOK). `AUTH_SECRET`, `QR_SECRET` and `REWARD_CODE_SECRET` rotate on a leak, on suspicion or when someone
leaves. (2) `AUTH_SECRET` and `QR_SECRET` have no previous-key slot (`REWARD_CODE_SECRET` has one, ADR-725). A rotation of `AUTH_SECRET`
loses the deletion marks (Q-141), the opt-out links already sent, the links of open owner email changes and the App Review code; a rotation
of `QR_SECRET` ends the printed or written codes of eight purposes, not only the quest QR. The RUNBOOK said "nothing stored depends on" for
`AUTH_SECRET` and named only the quest QR for `QR_SECRET`; both paragraphs now point at the inventory. (3) The RUNBOOK has no rotation
steps for the APNs `.p8`, the FCM and Gmail service accounts, the Msegat and Resend keys or the database and Redis passwords, and no alert
fires before a key expires (SLO.md section 2). (4) Who can read the CranL secret store is unconfirmed (Q-664). (5) The policy is not mapped
phase by phase to NIST SP 800-57.
**Recommended (developer):** keep the rotation of the three secrets event-driven (a routine `AUTH_SECRET` rotation costs the deletion marks
and a routine `QR_SECRET` rotation costs every printed sheet, for no gain while the keys only sign or hash) and say so in QUALITY_BASELINE
section 4; write the provider-key rotation steps in the RUNBOOK when the keys exist (the push go-live checklist, T-806); add a previous-key
slot to `AUTH_SECRET` only if Q-141's marks must survive a rotation; ask CranL about the secret store with Q-664's list in T-811.

## Q-701 - Sign-in strength of the operator's own accounts is not recorded (T-810, ASVS V6.1.3)

**Status:** Open (developer, 2026-11-06).
SECURITY.md "Sign-in pathways and their strength" covers the product. It cannot record how the CranL account, its API key and the
provider consoles (Google Workspace, Apple Developer, Firebase, Msegat) are protected: who holds each and whether each has a second factor.
The database owner connection is a static password given for a command (Q-664).
**Recommended (developer):** Dhia confirms that each of these accounts has a second factor and who holds it, and the date goes in this
entry; the CranL parts join the T-811 questions.

## Q-702 - The FOLLOWUPS batch of 2026-11-06: seven design choices to confirm (ADR-735 to ADR-741)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the FOLLOWUPS batch 2 code review 88): ADR-735 to
ADR-741 are Accepted as built; the 3 days of cheers and the 6-hour stock cooldown are kept.
The batch took the recommended option where the review left a choice: a failed top-10 diff goes to the back of the list
(ADR-735); a failing group push page backs off 1, 4, 16 minutes to an hour and parks at the third failure (ADR-736); an
ended moment's cheers go after 3 days (ADR-737); an Ask Questify and an Allow are serialized on the event row (ADR-738); a
duplicate runs at REPEATABLE READ and retries once (ADR-739); the streak scan rests an hour after an empty pass, so a player
who becomes reachable in the evening waits up to an hour (ADR-740); a low-stock alert per reward or item waits 6 hours
before it mails again (ADR-741).
**Recommended (developer):** accept them as built after the batch's review. The two numbers a product owner may want to
change are the 3 days of cheers and the 6-hour stock cooldown.

## Q-703 - FOLLOWUPS batch 5 (2026-11-06): three design choices to confirm (ADR-742 to ADR-744)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the code review 90): accepted as built.
The batch took the recommended option where the follow-ups left a choice: the Amounts revert asks without naming the amounts
it restores (ADR-742); the feature-usage page drops the review demo's organizer in the API (ADR-743); Questify home text
refuses zero-width marks and stores whitespace-only text as empty (ADR-744, migration 0161).
**Recommended (developer):** accept them as built. If an admin should see the old to new lines on an Amounts revert, add the
audit entry's `before` to the amounts list answer.

## Q-704 - FOLLOWUPS batch 6 (2026-11-06): five design choices to confirm (ADR-745 to ADR-749)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the code review 91): accepted as built.
The batch took the recommended option where the follow-ups left a choice: closing reports with an action needs that action
in place, and two parts of the T-705b line are kept with their reasons (ADR-745); catalog names refuse zero-width marks and
whitespace alone (ADR-746); an index on an organizer's events by creation time, after the plan showed a sort of all 3,000
(ADR-747); the health view's oldest push and notice read through two partial indexes (ADR-748); promtool runs in
`ci:changed` when the alert rules or the monitoring stack change (ADR-749).
**Recommended (developer):** accept them as built.

## Q-705 - Which feature switches the server refuses on, and which only change what it does (T-703 review, ADR-453)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the FOLLOWUPS batch 5 code review 82): read from the
code on 2026-11-06 (FOLLOWUPS batch 7);
nothing to build. ADR-453 says a switched-off feature is hidden "by the server's doors"; that holds for 25 of the 27
switches in `FEATURES` (`packages/shared/src/config/registry.ts`). Two have no door to refuse (`dailyStreak`,
`pushNotifications`): off, the server counts, pays or sends nothing. Every switch is read on the server somewhere; the
table says where, and the answer a caller gets. A new switch adds its row here in the change that builds it.

A refusal is `403 feature_off` unless the row says otherwise (`featureOff` for an event's switch, `platformFeatureOff` for
a Questify-wide one, `apps/api/src/auth/http-errors.ts`). "Stays" is deliberate (the registry comments and ADR-233,
ADR-226, ADR-540 say why).

| Switch | Level | Where the server reads it, and what it does when off | Stays open by design |
|---|---|---|---|
| `agenda` | event | `GET …/sessions` and `POST …/sessions/{id}/register` (`requireEventFeature`); `session_check_in` and `operator_sessions` (0093, AG403) | cancelling a registration; the team's page |
| `bigScreen` | event, add-on | the screen's reads, scenes and finale (`big_screen_on`, 0083, 0084, 0085) | |
| `boosts` | event | saving a boost (`feature_off` platform or organizer layer, `event_feature_off` the event's); `boosts_on` (the event's switch) stops every boost paying at once | a boost already in force when only the platform's switch goes off pays to its end (ADR-233, ADR-540) |
| `cheers` | event | starting a moment (0090) and a tap (`cheers_live_until`); the moment ends at once | |
| `community` | event | saving and deleting a goal, the player's community read, the settle's "may start" (`platform_feature_on`, ADR-542) | a running goal settles and pays its reached steps |
| `dailyChallenge` | Questify | the play function raises DC404 `unavailable` (0069); the view returns nothing | |
| `dailyStreak` | Questify | **no refusal**: `daily_streak_on()` false counts no day, shows nothing and pays no milestone (0068, 0069, 0079) | |
| `dailyWord` | Questify | the guess function raises DW404 `unavailable` (0069); the view returns nothing | |
| `flashQuests` | event | launching (FF403), and a flash quest is hidden and refused (`flash_on`, 0136) | |
| `helpDesk` | event | sending a question or a report (`featureOff`, `tickets/routes.ts`) | reading, answering and marking seen |
| `invitationCampaigns` | Questify | requesting a campaign (`platformFeatureOff`), the sender tick (`tick.ts`) | results keep being counted |
| `locationQuests` | Questify, off until a Questify admin turns it on | the builder refuses the location type (`quests/routes.ts`, change sets), a check-in is refused (`completions/complete.ts`) | the quest's QR |
| `kiosks` | Questify | the kiosk scan and the live code (`devices/kiosk.ts`, `devices/live-code.ts`) | pairing and the Devices page |
| `maps` | event | `GET …/maps` (`requireEventFeature`) | the team's Maps page and every pin |
| `meetSomeone` | event | the meet pass and scan doors (QF403, ADR-541) | |
| `miniGames` | event | starting a round (QF403, ADR-541) | a started round finishes |
| `nfcTags` | Questify | the NFC reading door (`nfc/routes.ts`) | the quest's QR |
| `polls` | event | a live poll's vote and reads (`polls_off`, 0094, 0083) | votes already cast; the team's results |
| `pushNotifications` | Questify | **no refusal**: `push_on()` false claims and sends nothing, queued pushes expire (0076, `push/worker.ts`) | registration, mutes, settle and the notification center |
| `questifyRanking` | Questify | `GET /v1/questify/ranking` answers 404 `ranking_off` (QW404, 0072) | the boards keep being written |
| `questRatings` | event, off until the owner turns it on | `PUT /v1/quests/{id}/rating` answers 409 `ratings_off`; the read says `on: false` (`ratings/routes.ts`) | |
| `ranking` | event | the ranking door answers 404 `ranking_off` (`ranking/routes.ts`); Home hides the card | the boards keep being written |
| `rankingToday` | event | the same door answers 404 `today_ranking_off` | |
| `shareQuests` | event | the share completion (`plays/shares.ts`) and every quest list hide the type (`switched-off.ts`) | |
| `shop` | event | the shop read, a goal pin, a new reservation and the desk sale (0094, 0107, `rewards/routes.ts`) | a prize a player already holds is handed over at the desk |
| `stations` | Questify | the station's screen code (`devices/devices.ts`) | pairing and the Devices page |
| `usernameChanges` | Questify | `PATCH /v1/me` with a username answers 403 `username_changes_off` (`players/profile.ts`) | |

**Recommended (developer):** keep as built. ADR-453's sentence is right for 25 switches and loose for two, which are
switches of what a worker or a counter does. If a test should hold the table, one that lists `FEATURES` against a door
map would catch a new switch with no row; it is not built, and a new switch adds its row here by hand.


## Q-706 - FOLLOWUPS batch 7 (2026-11-06): five choices to confirm (ADR-780)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the FOLLOWUPS batch 5 code review 82): accepted as
built. The batch chose: the catalog's name pairs (`catalogPair`) refuse zero-width marks while `cleanText` and
`hasUnsafeCharacter` stay as they are, because template body text is never read by `catalog_text` and translation
overrides share the pattern of `hasUnsafeCharacter` (the shipped texts keep U+200E) (ADR-780 (1)); `alerts:check --always` for the nightly run
and `ci:full` (2); a short title for the today-ranking confirmation (3); SIGTERM and SIGHUP stop a load run like Ctrl+C
(4); the lost-mailbox and lost-number steps written from the doors that exist, and `staff.cjs create` kept as it is with
a random unseen password (5).
**Recommended (developer):** accept. Open for Dhia only if he wants `create` to send an invite or force a first password
change (a migration and a sign-in change, tier A), or a support door that moves a player to a new number (ADR-423 dropped it).

## Q-720 - T-404c: the split and the two migrations (ADR-761, ADR-762)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the tier A plan review 86): as the plan recommends.
T-404c (tier A) removes gems everywhere and adds the server rewards; T-404d (tier B) adds the Journey screen and badges.
Between them the bar has four tabs on `main`. Migration 0163 touches only `platform_setting`; 0164 does the rest
(renumbered after main took 0162).
**Recommended (developer):** as planned. Alternative: one part, which puts the screens under the tier A review.

## Q-721 - Achievement tier XP amounts and no back pay (ADR-764)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the tier A plan review 86): as the plan recommends.
Tiers pay 50, 150 and 300 XP (editable, 0 to 1000) when earned; tiers earned before the change pay nothing.
**Recommended (developer):** as planned. Alternative: pay earned tiers at the next sync, which lifts this month's
Questify ranking for everyone with tiers at once.

## Q-722 - Gem balances vanish; bought items show as "A Questify reward" (ADR-763)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the tier A plan review 86): as the plan recommends.
**Recommended (developer):** drop balances with no conversion; keep bought items with the `questify` source.
Alternative: give each player XP for unspent gems (it invents an exchange rate).

## Q-723 - Achievement items: one per achievement; gold tiers seeded with the former shop frames (ADR-765)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the tier A plan review 86): as the plan recommends.
**Recommended (developer):** one item per achievement at a tier the admin picks; seed the five gold tiers. Alternatives:
an item per tier (three per achievement), or silver instead of gold for the seeds so more players reach them.

## Q-724 - The level on event rankings and the tab name (ADR-766, ADR-767)

**Status:** Answered (Dhia, 2026-11-06, AskUserQuestion): the tab is named **"Journey"** («رحلتي»), not "Levels";
the level shows on the app's event rankings, the podium and profiles, not on the big screen.
The plan had the level beside names on the app's event ranking and podium and the tab called Levels.

## Q-725 - The event currency icon "gem" and the terms of use (ADR-768)

**Status:** Answered (Dhia, 2026-11-06, AskUserQuestion): keep the event currency's gem icon.
Organizers can still pick a gem icon for their event's points. The terms of use lose Questify gems; whether that needs
a new terms version that players accept again is a legal call.
**Recommended (developer):** keep the icon; edit the terms text at build and leave the version bump to the legal pass.

## Q-730 - The console history shows the typed reason and more actions in words (ADR-790, ADR-791)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the code review 92): accepted as built.
**Recommended (developer):** show the reason beside a suspension and its lifting, and word the 23 lifecycle, results, ban, take-down and team actions; leave the rest by name until a support case needs one. Alternative: word all audit actions now (about 170 more texts in two languages) or none.

## Q-750 - Who deploys production once the build is on the company server (ADR-810)

**Status:** Open (2026-11-06; to decide before the first production deploy).
A key that can run commands in production apps, kept on a server outside Saudi Arabia, could read personal data from there.
**Recommended (developer):** production deploys run from CI or from a machine in Saudi Arabia, with `apps:exec` and `env:reveal` left off any key on the company server.

## Q-740 - How long a change set's apply holds its set (ADR-800)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the code review 93): as built.
A crash mid-apply leaves the set answering busy until the claim runs out. Shorter frees it sooner; longer keeps a slow apply
from overlapping another (which still cannot apply an item twice).
**Recommended (developer):** 5 minutes.

## Q-741 - Which event decides whether a duplicate takes the big screen's scenes (ADR-802)

**Status:** Answered (developer, delegated by Dhia, 2026-11-06, after the code review 93): as built.
The line asked to stop copying to an event without the add-on, but a new draft never has it yet, so that would drop the scenes
for every buyer.
**Recommended (developer):** copy only from a source that holds the add-on.

## Q-742 - Batch 10's three calls: flag alert window, real staff in the demo, the dropped index (ADR-811)

**Status:** Decided (developer, delegated by Dhia, 2026-11-07): as recommended, ADR-811 accepted.
**Question:** is a 15-minute window right for `new_flags`, does the demo event stay closed to real staff, and is `event_organizer_idx`
safe to lose at a member change's slower read? **Recommended:** yes to all three, as built in migration 0167.

## Q-743 - Should an announcement also count session messages? (ADR-813)

**Status:** Open (worker's recommendation in ADR-813; the coordinator decides after review).
**Question:** the limit is shared one way only: a session message counts announcements, an announcement does not count session
messages. **Recommended:** keep it one way, as built in migration 0168.

## Q-751 - How long should the first set-password link last? (ADR-814)

**Status:** Decided (developer, delegated by Dhia, 2026-11-07): as recommended, ADR-814 accepted.
**Question:** `create`'s link lives in `staff_password_reset`, whose sweep removes rows after 1 day. **Recommended:** 24 hours, then "Forgot your password?". Team invites last 7 days, but matching them needs a policy change or a new table.

## Q-752 - Should a failed held-change notice close the change or be resent? (ADR-815)

**Status:** Decided (developer, delegated by Dhia, 2026-11-07): as recommended, ADR-815 accepted.
**Question:** a failed send can close the change at once, or the worker can retry it during the 24 hours. **Recommended:** close it; the admin can start again. Failover does not soften this today: `RESEND_API_KEY` is not set in `ops/cranl/*.json`, so one Gmail failure closes the owner's change.

## Q-753 - When should `ledger_entry` get an index on `quest_id`, and how are big indexes built after launch? (ADR-816)

**Status:** Decided (developer, delegated by Dhia, 2026-11-09): as recommended, ADR-816 accepted. Was: Open. Recommended options taken in T-813 part 1; the coordinator decides after the review.
**Question:** (1) a quest delete checks the ledger once per quest, so a delete costs one check times the quests it removes (a draft's
`deleteDraft` cascades to all its quests, `deleteQuestsOf` to a category's). On `quest_id` alone a check scanned the whole ledger,
290 ms at 2.1 million rows (280 to 350 ms in earlier runs), about 140 to 175 ms a million rows: a draft of 26 quests took 7.8 s, past
the 5 s statement_timeout, and one quest alone would reach about 1 s at 6 to 7 million rows. 0174 makes the key `(quest_id,
event_id)`, so a check reads only its event's rows, at no write cost: the draft 0.23 s, a category of 10 in a small event 0.11 s. The
largest event is not helped: 10 quests in an event of 1.1 million ledger rows took 3.0 s before and after, about 300 ms a quest, so a
category of about 17 quests there passes 5 s, and one quest reaches 1 s at about 3.5 million rows in one event. An index on
`quest_id` (28 ms a quest) would cure it for one more index entry on every completion. **Recommended:** leave the index out, and add
it when one event's ledger nears 500,000 rows (about 135 ms a quest, so some 37 quests to 5 s) or a category delete is seen over
1 s. The seeded 100,000-player event is past that already, so a real event of that size should get it before it runs. (2) A migration cannot use `CREATE
INDEX CONCURRENTLY`, because the runner holds each file in one transaction, so a big index stops writers on that table for the build.
**Recommended:** keep the runner as it is until there is a live event to protect. Then build such an index by hand with
`CONCURRENTLY` before the release, and check it: `SELECT indisvalid FROM pg_index WHERE indexrelid = '<name>'::regclass` must be
true. A failed or cancelled concurrent build leaves an INVALID index, which `IF NOT EXISTS` would accept silently and which serves no
read; drop it (`DROP INDEX CONCURRENTLY`) and build again. Only then ship the file, with `CREATE INDEX IF NOT EXISTS` and without
the up-front `LOCK TABLE` lines, which would otherwise stop writers for nothing.

## Q-754 - Should the username word lists check a Full name answer, and where? (ADR-817)

**Status:** (1) decided by Dhia, 2026-11-08, and refined by him the same day after 0178's review (the follow-up): a bad word
with one or two letters added is still the same bad word, but with many more letters around it, it may be a good word that just
contains those letters; test it on many names and options so that no bad name is missed and no good name is banned (migration
0178, ADR-817 Accepted). As built: a word of a full name is refused when, with one known prefix and one known ending taken off
(they do not count), it holds a list entry with few letters left over: at most 2 for a `part` entry of 4 letters or more, 1 for
any other entry of 3 or more (`word` entries included), none for one of 1 or 2. Tuned on 750 real names and 220 abusive ones:
the chosen setting refuses no abusive name and 83 real names without an allow-list (ADR-817 has the table of settings tried).
After 0178's second review the corpus holds 770 real names and 250 abusive ones: all real names pass, all abusive ones are
refused, and the allow-list holds 77 words (ADR-817 lists them; 18 added by that review: «لحسين», «جماعي», «شرجي», «زبيدات»,
asser, assis, assi, kasser, wasser, lasser, hasser, sasser, cuma, titi, tita, manus, anush, butters). An allow word is skipped
only with no digit in it (dick5, kike88 are refused), and never after يا («ياخولي», «يا خولي» are refused). **Accepted passes**
(Dhia's trade-off, pinned by a test, 11): fuckyou, fuckoff, fuckali, Ali Fuckali, shitali, shitbag Omar, dumbfuck, pornstar,
Pornstar Ali, bigfuckingdick, smartass; the first ten were refused by 0177. **Compounds** are entries of their own so they stay
refused: five `part` entries (fuckface, fuckhead, fuckwit, shithead, shitface) and 18 `word` entries (dickhead, cocksucker,
jackass, dumbass, asshat, asswipe, cumslut, cumdump, dickface, cuntface, twatface, fatass, fucktard, slutbag, whoreson,
«كسامك», «كسختك», «كساختك»; «كسأمك» folds to «كسامك»). Usernames: the `word` compounds newly refuse a username whose token is
the compound itself ("jackass", "dumbass_7", «كسامك»; never "jackassery" or "dumbasses"); nothing else changes. (2) decided by Dhia the
same day: «Kike» stays on the allow-list. Coon (English) and Mong (Hmong) are `word` entries and stay refused, now also with one
letter or an affix (Cooney, Monge, Mongi pass by the allow-list). (3) is open.
**Question:** a full name shown to every player is free text (ADR-400). Options: (a) refuse it at the join only; (b) hide a failing
name where other players read it only; (c) both. **Recommended: (c)**, with the username lists and folding and nothing else: the join
says so while the player can change it ("That name can't be used. Enter another name."), and a stored name caught by a word added
later is flagged and hidden, so no listed word reaches the ranking, the results or the big screen. The staff still see the answer as
typed.
**Real names a list can refuse (review of the first version, 2026-11-08). Superseded by 0178:** run on the 0178 corpus, all
750 real names pass, these included (Siriporn, Supaporn, Somporn, Kanokporn, Pornthep, Shitole, Shitara, Slutskaya and
Wankowicz by the rule, Shittu, Skeete and Bastardi by the allow-list, «کسمایی» by the rule); Coon and Mong are still refused
(above); all 220 abusive names are refused. The paragraph as it stood: The lists were made for usernames. On full names the first
version refused, inside one word: «إسحاق», «يوسف إسحاق», Yamashita, Kinoshita, Wankhede, Atwater, Pornchai; across two words: «ملاك
سمير», «مبارك سمير», «عبدالملك سميح», «عبّاس كسّاب», Anas Lutfi, Ilyas Lutfy, Yunus Hitti, Abbas Hitti; and whole words that are list
entries: Ali Butt, Dick Smith, Kevin Poon, Kike Garcia, Hooker. The rewrite checks word by word and skips an allow-list of name words
(`full_name_allow`, 43 seeded; an Arabic entry also covers its article and nisba forms, so «محمد الإسحاقي», «الاسحاقي»,
«عبدالله البلوطي», «منذر البلوطي» and «علي السكسكي» now pass), and a corpus of 242 common names passes (ADR-817). Run on
2026-11-08 after the re-review, these real names are **still refused**, each holding a list word not on the allow-list: Thai
names with "porn" (Siriporn, Supaporn, Somporn, Kanokporn, Pornthep), Shittu (Yoruba), Shitole (Marathi), Shitara (Japanese),
Slutskaya (Russian), Skeete (Barbadian), Coon (English), Mong (Hmong), Bastardi (Italian), Wankowicz (Polish) and the Persian
«کسمایی» (Kasmaei). Each can be added to the allow-list by a migration.
**For Dhia (1):** should "porn" match only as a whole word in a full name? Inside a word it refuses many common Thai names
(above); as a whole word it would still refuse "Ahmed Porn" but let "Pornstar Ali" through. Recommended: whole word only in full
names, usernames unchanged.
**For Dhia (2):** «Kike» is on the allow-list because it is a common Spanish nickname (Kike García), but it is also an
antisemitic slur in English, so "Kike Smith" passes. Keep it allowed (recommended, as Spanish speakers use it as their name), or
take it off and refuse those names? Unchanged until you say.
**For Dhia (3):** a player whose stored name becomes hidden (a word added to the lists later) is not told and cannot change it: there
is no answer-edit route, and a rejoin keeps the answers given before (T-220). They show by username in the ranking, the results
and the big screen, while the staff still see the name. Is that acceptable, or should such a player be told and allowed to give
another name (a notice and an answer-edit flow, a separate task)? Recommended for now: accept it, since only an admin's list change
causes it and the allow-list can be widened by a migration.
**For Dhia (4)** (0178's second review, 2026-11-08): four words that are real names somewhere are left refused in a full name,
as each is also the plain bad word: «يانيك» (Yannick; also "I fuck you, O"), «نيكي» (Nicky; also "fuck me"), Semen (a Turkish and
Indonesian given name) and Porn (a Thai given name). Each can join the allow-list by a migration, which would let the bad word
through as well. Recommended: keep them refused until a player is affected.
**For Dhia (5)** (0179's review, 2026-11-08): the Arabic forms «نازي» and «هتلر» are not listed (نازي passes as a username); and
"Fuk You" passes a full name because Fuk is a Cantonese given name (Wong Fuk Wing). Likewise "Fuks Off" and "F U K" pass (pinned
as accepted passes). Say if you want any of them refused.

## Q-755 - Should operator routes be refused to a player web session? (T-803 P2, ADR-818)

**Status:** open; recommended and built: yes. The forwarder answers 404 to `/v1/operator/*` and `/v1/me/operator-events`
for a request with the player cookie, and never sends them a bearer. Operator screens stay on the phone.
**Question:** should operators work from a browser too? Opening them later means reading each operator screen's needs on the
web (camera, NFC) and the ship gate of SECURITY.md abuse case 11.

## Q-756 - How does the web build follow `MIN_APP_VERSION`? (T-803 P2)

**Status:** open; recommended: the web build sends its own version as `X-App-Version`; a 426 makes the app reload once (P3),
and RUNBOOK says to deploy the web build before raising `MIN_APP_VERSION`.
**Question:** is one reload enough, or should the web build be exempt from the minimum (it is always the deployed version)?

## Q-757 - Is a `signupToken` in a browser body acceptable? (T-803 P2, ADR-818)

**Status:** open; recommended: yes. Verify's new-player step passes `{ isNew, signupToken }` to the page: the token lives 15
minutes, is bound to its challenge, and only creates the account the code just proved.
**Question:** should the forwarder hold it in a cookie as well? That adds a second cookie for a short, single-use value.

## Q-758 - Should a contact change from a `web` family need a step-up code? (T-803 P2, SECURITY.md abuse case 11)

**Status:** answered (Dhia, 2026-11-11): keep as today, on the phone app and the web build alike. A contact change needs
only the code sent to the new contact; the CSP gate is the v1 defence, and the risk stays documented (ADR-715, SECURITY.md
abuse case 11). The 2026-11-11 security audit raised the same point (hardening note 1).
**Question:** an XSS on the shared web origin can act as the player through the cookie, and a contact change (pathway row
13) sends the code only to the new contact, a lasting account takeover. Is the CSP gate enough for v1?

## Q-759 - Should email operator invites share the team invites' daily count? (ADR-823)

**Status:** answered (Dhia, 2026-11-11): their own count, 500 a day whether or not an event is activated, so the
team invites' 30 and 10 no longer apply to them; ADR-823 (2).
**Question:** one shared count per organizer would cap the invite mail one organizer can send, but an event's volunteer
invites could then stop the owner inviting a co-owner for the day. Is the separate count right?

## Q-760 - Should a refused operator scan still show who was scanned? (ADR-824)

**Status:** open; recommended no (ADR-824, migration 0189): an operator without `scan_quests`, or scanning a quest
outside their limit, sees no player on the refusal, and an operator with neither pairing ability gets no device preview.
**Question:** the station screen showed the scanned player's chip on every refusal, which let an operator without the
scan ability read names. Is a refusal with no chip right for `ability_off` and `outside_station`?

## Q-761 - Should a suspended event keep its give-back doors open, and its souvenirs wait? (ADR-825)

**Status:** open; recommended yes (ADR-825, migration 0190): while an event is suspended, a player cannot rate, stamp,
reserve, play, collect or accept through any route naming its objects, but can still decline a desk sale or cancel or
decline a reservation; the souvenirs it owes are granted after the lift, not dropped.
**Question:** is a suspension that holds everything but the doors that give points back right, and should owed
souvenirs arrive after a lift (rather than never, for an event suspended for fraud)?

## Q-762 - When must the HTTP idempotency store leave the process? (hunter-tenant 6)

**Status:** open; recommended: before a second API instance, or rolling deploys with client retries.
**Question:** the HTTP idempotency layer keeps its replies in memory, per process (src/idempotency-store.ts). The points
doors also carry database keys (T-105), so a retry that lands on another instance is still paid once; a route with no
database key is not. Before running two instances, list the idempotent routes without a database key and either give
them one or move the store to PostgreSQL or Redis.

## Q-763 - How long does an old `AUTH_SECRET` stay as the previous opt-out key? (w2-crypto 4)

**Status:** open; recommended: 90 days after a routine rotation, none after a leak (ADR-826).
**Question:** after a rotation the old secret is kept only to read opt-out links already sent. 90 days covers the life
of a promotional message in an inbox; a longer window keeps more links working, a shorter one holds an old secret less
long. Is 90 days right, and should the removal be a calendar reminder or a check that warns when the pair is older?
