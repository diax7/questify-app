# Legal documents (players and organizers)

> v0 drafts written for T-119 on 2026-10-20 so that sign-up (T-110) can record which version a
> player accepted. **None of these has been reviewed by counsel.** Counsel reviews them in T-807;
> the Arabic is also reviewed by a native speaker (`STORE_COMPLIANCE.md` §5, Saudi Arabia).

| File | What it is | Where the app shows it |
|---|---|---|
| `terms-of-use.md` | The agreement between the player and Questify: eligibility, account, organizers, points, prizes, content licence, bans, deletion, law | Sign-up before any data is collected (FR-1705); again before the first submission (FR-1706); Settings → Legal (FR-1707) |
| `privacy-policy.md` | What data is collected, why, who receives it, where it is stored, retention, rights, deletion | Sign-up (FR-1705); Settings → Legal; store listings |
| `community-guidelines.md` | Usernames, submissions, fair play, respect, reporting and blocking, enforcement and appeal | Before the first submission (FR-1706); the report flow; Settings → Legal |

### Organizer documents (FR-1726, F-252, ADR-079)

Drafted on 2026-10-20 for T-101 (organizer sign-up). The owner accepts all three by click-through
when creating the organizer account; the dashboard records each document's version and the time,
and a changed document must be accepted again at the next sign-in before the owner continues.

| File | What it is |
|---|---|
| `organizer-terms.md` | Organizer terms: account, one owner and editors, Draft events, activation by Questify after the invoice is paid, fees by invoice outside the platform, running events, points and prizes, duties to players, brand licence, suspension, termination and data afterwards, liability, law |
| `organizer-dpa.md` | Data processing agreement under PDPL: who controls which data, instructions, residency, sub-processors, security, breach notice, data-subject help, deletion at the end, audits |
| `organizer-content-rules.md` | What organizers may publish: lawful and fit for 13+, no chance or gambling, no physical-harm challenges, privacy, accurate prizes, sponsors, how Questify reports and unpublishes |

Each file carries `version: 0.1-draft` in its header, then the full Arabic text, then the full
English text, with the same section numbers. Arabic is the primary text (NFR-015, PD-25). Western
digits in both (ADR-018).

Not covered here: the per-event official prize rules (generated from event settings, PD-07), the
account-deletion web page and the support page.
They are separate documents (`STORE_COMPLIANCE.md` §4).

## Placeholders

| Placeholder | Meaning | Waits on |
|---|---|---|
| `{{LEGAL_ENTITY_NAME}}` | The party that operates Questify and is named as controller | Q-078 (individual seller ADR-010 vs the company ADR-076), Q-043 |
| `{{CR_NUMBER}}` | Commercial registration number of that entity | Q-078 |
| `{{REGISTERED_ADDRESS}}` | Its registered address | Q-078 |
| `{{CONTACT_EMAIL}}` | Player support email (also shown in the app's contact page, FR-1731) | User |
| `{{PRIVACY_CONTACT}}` | Privacy contact or data protection officer | Q-044 |
| `{{DELETION_PAGE_URL}}` | The account-deletion web page (FR-127) | Web app deploy |
| `{{EMAIL_PROVIDER}}` | The service that sends player email codes, if outside the Kingdom | Q-034, Q-083 |
| `{{RESPONSE_DAYS}}` | Response time promised for data-subject requests | Q-085 |
| `{{RETENTION_LOCATION}}`, `{{RETENTION_EVENT_DATA}}`, `{{RETENTION_TICKETS}}` | Retention periods per data type | Q-075 |
| `{{RETENTION_PRIZE_RECORDS}}` | How long prize-handover records stay after deletion (FR-128) | Q-051 |
| `{{RETENTION_FINGERPRINT}}` | How long the deletion fingerprint stays (FR-1704) | Q-075, Q-051 |

New placeholders in the organizer documents (the ones above are reused where they apply):

| Placeholder | Meaning | Waits on |
|---|---|---|
| `{{REFUND_TERMS}}` | Refunds and cancellation of a paid event | User + counsel (Q-088) |
| `{{TERMINATION_NOTICE_DAYS}}` | Notice Questify gives before ending the organizer terms | Q-088 |
| `{{RETENTION_ORGANIZER_DATA}}` | How long event data stays after the organizer account ends | Q-075, Q-088 |
| `{{LIABILITY_CAP}}` | Questify's total liability to an organizer | Q-085 (c) |
| `{{SUBPROCESSOR_NOTICE_DAYS}}` | Notice before a sub-processor is added or replaced | Q-088 |
| `{{BREACH_NOTICE_HOURS}}` | Longest time before Questify tells the organizer of a breach | Q-088 |
| `{{AUDIT_TERMS}}` | The organizer's audit rights (questionnaire, report, on-site) | Q-088 |
| `{{ERROR_TRACKING_PROVIDER}}` | The error-tracking service (self-hosted GlitchTip preferred, `INTEGRATIONS.md`) | Build |

`{{EMAIL_PROVIDER}}` is Google (Gmail API) today (ADR-112) and stays a placeholder until Q-083.
The DPA names CranL (hosting, ADR-107) and Msegat (SMS, ADR-103) because a DPA must list
sub-processors; both may change (T-811), which the notice clause covers.

Audit-log retention (Q-084) is not stated separately; the policy says admin-log entries are kept
with the player's identity removed (FR-1739, NFR-019).

## Questions for counsel

1. Who is the controller, and is Questify a controller, joint controller or processor of event data? (Q-043, Q-078)
2. Ages 13 to 17: full legal capacity, guardian consent, and whether a minor can accept these terms and opt in to marketing (Q-042; ADR-084 lets 13–17s use the app like adults).
3. Is Questify as administrator, with the organizer as prize provider, enough for Apple 5.3.1? (Q-040)
4. Do rank prizes at commercial or corporate events need a Chamber licence? (Q-041)
5. National Register of Controllers and a DPO (Q-044)
6. Is the draft Consumer Protection Law in force (Arabic-only duties)? (Q-047)
7. Retention periods per data type, prize and moderation records after deletion, audit-log anonymisation (Q-075, Q-051, Q-084)
8. Transfers abroad: Apple and Google push, wallet passes, device integrity, the Play install referrer, a foreign email provider (Q-043, Q-083; data map NFR-020)
9. Showing a player's full name to other players when the organizer chooses it (Q-080, ADR-106)
10. Legal basis per purpose, response time for requests, liability limit, dispute forum (Q-085, new)

Organizer documents:

11. The role split in the DPA (Q-043, Q-078). The docs do not settle it. The draft follows what
    they imply: Questify is controller of player accounts, profiles and cross-event history
    (`privacy-policy.md` §1 and §4; ADR-047's single player database); the organizer is controller
    of the event data it chooses to collect and receives (join fields F-78, join card PD-17 and
    FR-121, exports FR-1206 and FR-1207), with Questify as processor. Event activity is used by
    both (the organizer's dashboard, and Questify's own history and invitations, ADR-047), so
    counsel may prefer joint or separate controllership for it.
12. Transfers abroad of event data (push, wallet, device integrity, a foreign email provider):
    which PDPL transfer safeguard applies, and do SDAIA's standard clauses belong in the DPA?
    (Q-043, Q-083; `STORE_COMPLIANCE.md` §4 names SDAIA standard clauses.)
13. Rank prizes: the terms put any competition licence on the organizer (Q-041).
14. Organizer-side commercial terms: refunds, termination notice, retention after termination,
    breach-notice window, sub-processor notice, audit rights, indemnity (Q-088, new).

## Drafting choices to confirm (organizer documents)

- Suspension for an unpaid invoice and the organizer's indemnity are not in any ADR; they are
  common B2B terms added for counsel to keep or cut.
- The content rules forbid making a purchase a condition for points or prizes (from the Ministry
  of Commerce rule in `STORE_COMPLIANCE.md` §3) and forbid sensitive data in join fields; neither
  is an ADR yet.
- The DPA says deleting a player account also deletes that player's data in the organizer's event.
  The privacy policy lists what deletion removes, but join answers are not named there (FR-126).
- The DPA says encrypted backups are kept inside the Kingdom. Today that is a release-gate
  condition, not yet built (ADR-107 addenda, T-019, T-811).
- Organizer account deletion is an owner power (ADR-077), but no requirement describes what
  happens to the events and data, so section 11 of the terms is new ground (Q-088).

## Drafting choices to confirm

- The terms say event rules prevail over the terms on matters about that event (section 4).
- The content licence is non-exclusive, free, limited to storing, reviewing and showing within the event.
- The privacy policy says an account found to belong to someone under 13 is deleted (through the
  admin legal-request tool, FR-1778).
- The SMS gateway is described as "a licensed Saudi gateway" and the host as "inside the Kingdom",
  without vendor names, because both may change (ADR-103, ADR-107 addendum).
