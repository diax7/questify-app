# Legal documents (players)

> v0 drafts written for T-119 on 2026-10-20 so that sign-up (T-110) can record which version a
> player accepted. **None of these has been reviewed by counsel.** Counsel reviews them in T-807;
> the Arabic is also reviewed by a native speaker (`STORE_COMPLIANCE.md` §5, Saudi Arabia).

| File | What it is | Where the app shows it |
|---|---|---|
| `terms-of-use.md` | The agreement between the player and Questify: eligibility, account, organizers, points, prizes, content licence, bans, deletion, law | Sign-up before any data is collected (FR-1705); again before the first submission (FR-1706); Settings → Legal (FR-1707) |
| `privacy-policy.md` | What data is collected, why, who receives it, where it is stored, retention, rights, deletion | Sign-up (FR-1705); Settings → Legal; store listings |
| `community-guidelines.md` | Usernames, submissions, fair play, respect, reporting and blocking, enforcement and appeal | Before the first submission (FR-1706); the report flow; Settings → Legal |

Each file carries `version: 0.1-draft` in its header, then the full Arabic text, then the full
English text, with the same section numbers. Arabic is the primary text (NFR-015, PD-25). Western
digits in both (ADR-018).

Not covered here: the per-event official prize rules (generated from event settings, PD-07), the
organizer terms, DPA and content rules (FR-1726), the account-deletion web page and the support page.
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

## Drafting choices to confirm

- The terms say event rules prevail over the terms on matters about that event (section 4).
- The content licence is non-exclusive, free, limited to storing, reviewing and showing within the event.
- The privacy policy says an account found to belong to someone under 13 is deleted (through the
  admin legal-request tool, FR-1778).
- The SMS gateway is described as "a licensed Saudi gateway" and the host as "inside the Kingdom",
  without vendor names, because both may change (ADR-103, ADR-107 addendum).
