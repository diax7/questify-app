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
| Q-075 | Retention periods per data type: location readings, photos, help tickets, logs, closed-event data, inactive accounts, organizer exports, the deletion fingerprint (FR-1704) | The privacy policy must state a period per type (`STORE_COMPLIANCE.md` §4); PDPL minimization | 8 (counsel, with Q-051) |
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
| Q-105 | Renamed words beyond T-117 (FR-404, FR-405, FR-940): (1) the star is one of the five currency icons, and it is also the usual XP symbol (ASSET_INDEX); an event that picks the star could confuse points with XP once XP shows (T-4xx). (2) ADR-058 also names renaming "quest" and "category", but no requirement asks for it yet. Claude's recommendation: keep the star until XP has its own symbol on screen, then decide; write a requirement for quest and category renames only if an organizer asks | The star choice may need a change when XP ships; quest and category stay fixed words | 8 (brand) |
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
ADR-248: tickets are deleted 90 days after their event ends (prize claims run up to 60 days), and at once with the
account. Agree, or keep them longer for disputes?

## Q-211 — Questify's access to tickets before escalation (2026-10-24, T-310 plan)
ADR-247: until T-312, no Questify admin can read an event's tickets, even for abuse or a legal request (only the
database owner can, as for every table). Agree, or add a logged console read now?
