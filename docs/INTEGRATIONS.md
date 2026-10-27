# External Integrations — Questify

> Every outside service Questify depends on, and what integrating each requires. Stage 6,
> 2026-10-17. This documents the plan; it does not create accounts. **No secret values appear here,
> only mechanisms.** Prices are public list prices checked on the date shown.

## Summary

| Service | Purpose | Auth model | Cost | Personal data crosses? | Sandbox? | Status |
|---|---|---|---|---|---|---|
| Saudi cloud (Q-031) | Hosting, PostgreSQL, Redis, storage, email | Cloud account, IAM roles | **Paid** | It hosts the data (inside Saudi) | Staging copy | **CranL Pro, riyadh-1** (ADR-107); production move reviewed at T-811 |
| Saudi SMS gateway | Login codes, operator invites, opted-in promotions | API key | **Paid** per SMS | Phone number, message text (in Saudi) | Test/trial sender | **Msegat** in use (ADR-103, Q-034); Taqnyat is the fallback |
| Email provider | Email login codes, team invites, invoices, opted-in promotions | API key / SMTP credentials | **Paid** | Email address, text | Test mode | **Gmail API** from `questify@nafes.com` (ADR-112), Resend as backup; final provider with counsel (Q-083) |
| Apple Push (APNs) | iPhone push | Auth key (.p8) | Free | Device token, message text (abroad) | Sandbox APNs | Required |
| Firebase Cloud Messaging | Android push | Service account | Free | Device token, message text (abroad) | Test project | Required |
| Apple Wallet | Event pass | Pass Type ID certificate; web service with per-pass token | $99/yr (the developer account) | Logo, name, dates, @username, score, balance, level, rank on the pass (ADR-091) | Test pass on a real iPhone | Q-076 |
| Google Wallet | Event pass | Service account; signed JWT | Free | Same | Demo mode | Q-076 |
| Apple App Attest / Google Play Integrity | Device-integrity flag signal | Per-platform attestation keys | Free | Device attestation | Yes | Flags only (ADR-041) |
| Expo EAS | Cloud builds, store submission, bug-fix updates | Expo access token | Free plan (15+15 builds/mo); Starter $19; Production $199 per month | **None** (code and assets only) | n/a | Accepted with ADR-101 |
| App Store Connect / Google Play Console | Distribution | API key / service account | $99/yr Apple, $25 once Google | Store listing only | TestFlight, internal testing | ADR-010 |
| Play Install Referrer | Android one-scan join | Google library | Free | A referrer string (the join code) | Yes | Required |
| Pwned Passwords (Have I Been Pwned) | Breached-password check on every staff password set (T-020) | None (public range API) | Free | **None**: only the first 5 hex characters of the password's SHA-1, with `Add-Padding` | n/a | In use. Timeout 3 s for the whole check; one retry on a network error, 429 or 5xx with at least 1 s left; fallback: fail closed (`503 breach_check_unavailable`, nothing changed). Egress to `api.pwnedpasswords.com` must stay open |
| Error tracking | Crashes and server errors | DSN token | Free self-hosted, or paid hosted | Must be none: scrubbed | Yes | Open (self-hosted GlitchTip preferred) |

## Saudi cloud (Q-031)

- **Purpose:** run everything and satisfy ADR-070 (personal data in Saudi Arabia).
- **Options compared (checked 2026-10-17):**
  - *Oracle Cloud Riyadh (since 2024) and Jeddah (since 2020):* normal sign-up; managed PostgreSQL
    with backups up to 35 days, point-in-time recovery, backup copies to another region and a
    cross-region warm standby; Oracle states 99.99% for multi-node, and RPO 0 for multi-node, 99.9%
    for single-node. Each region has one availability domain, so we run multiple nodes and a
    standby in the other Saudi city. Public example price: about $273 a month for 4 CPUs, 32 GB, 500
    GB (US list price, June 2024; Oracle says pricing is uniform across regions). **Not yet
    confirmed:** that the managed PostgreSQL service is offered in Riyadh and Jeddah specifically.
  - *Google Cloud Dammam (since Nov 2023, three zones):* a customer with a Saudi billing address
    must buy through the reseller CNTXT on invoiced billing; support also goes through CNTXT.
  - *AWS Saudi region:* announced for December 2026, not live. *Azure Saudi:* promised for Q4 2026,
    not confirmed. Neither can be planned on.
- **Auth and secrets:** cloud IAM roles for the server; secrets in the cloud secret store, never in
  code or git.
- **Sandbox vs production:** a separate staging environment in the same region, same configuration,
  fake data.
- **Failure behavior and degradation:** multi-node database with automatic failover (minutes at
  worst); backups copied to the second Saudi region; if the main region is lost, restore into the
  second (rehearsed before launch, NFR-026). If Redis is down, rankings are served from the database
  ordering (slower) and rebuilt after.
- **Data and PII:** this is where all of it lives.
- **To do:** verify the managed PostgreSQL and Redis/cache services in Riyadh/Jeddah in the console
  before the decision; ask for the real quote.

## SMS (ADR-103, Q-034)

- **Purpose:** login codes and operator invites from the service sender "Questify"; promotional SMS
  from a separately registered promotional sender (ADR-065).
- **Chosen because:** the user named **Msegat or Taqnyat**, both Saudi gateways. They are cheaper than
  global providers for Saudi numbers and CST-registered sender names are required locally.
- **Public prices (checked 2026-10-08 to -17, from provider pages and a third-party comparison):**
  - Taqnyat bundles, VAT included: 5,000 SMS for SAR 529 (0.106 each); 10,000 for SAR 920 (0.092);
    25,000 for SAR 2,185 (0.087); 50,000 for SAR 4,025 (0.081); 100,000 for SAR 6,325 (0.063).
  - Sender name registration at Taqnyat: SAR 230 a year per name; needs the commercial registration
    and a Chamber of Commerce authorization letter (the existing company can supply these).
  - Msegat: the third-party comparison shows a points system and the same SAR 230 a year per sender
    name; its own page shows no fixed per-SMS price. **Ask both for a written quote.**
  - Reference only: Twilio about SAR 0.73 per segment; Tawked SAR 0.09 per code.
- **What an event costs:** one login SMS per player at SAR 0.06–0.11 is about SAR 1,300–2,200 for
  20,000 players, plus resends. Questify absorbs it (ADR-099) and watches it in the usage view.
- **Auth and secrets:** API key in the secret store; rotated when staff change.
- **Endpoints/events used:** send, balance, delivery receipt callback (signed).
- **Rate limits:** provider caps and our own per-number limits (login codes) as tuning numbers.
- **Failure behavior (built, T-107):** timeout 5 s. Msegat has no idempotency key, so a retry after a timeout could
  send the code twice: one retry happens only when the request provably never left (connection refused, DNS). A
  timeout or an unreadable answer is "unknown": the code stays valid and the app offers an **email code** after 30 s
  (FR-1812). A definite refusal (any Msegat code other than `1`/`M0000`) ends the code and answers `sms_unavailable`
  with the email offer. 
  **One gateway at launch** (user's choice in the Stage 6 grill; Claude had recommended both
  Msegat and Taqnyat with automatic failover). Switching to the other is a configuration change made
  by a person, not automatic. **Risk accepted:** if the gateway fails at the start of a big event, a
  player who joined by phone and has no email on file cannot sign in until it recovers. Claude's
  low-cost suggestion, not decided: invite players to add an email right after their first sign-in.
- **Graceful degradation:** players with an email still sign in; browsing without signing in always
  works (ADR-031).
- **Data and PII:** phone number and the text of the message, all inside Saudi Arabia.

### Msegat API (checked 2026-10-19; the user has an active Msegat account with a services sender and an ads sender)

- **Base URL:** `https://www.msegat.com/gw/`. HTTPS `POST`, parameters URL-encoded or JSON in the body. Every call carries `userName` and `apiKey` (from Dashboard, API Key).
- **Send SMS:** `POST /gw/sendsms.php` with `userName`, `apiKey`, `numbers` (international format without `+` or zeros, comma-separated), `userSender` (an activated sender name), `msg`, `msgEncoding` (`UTF8` default or `windows-1256`). Optional scheduling and bulk fields exist. Success returns code `1` / `M0000`.
- **Msegat-generated OTP:** `POST /gw/sendOTPCode.php` (`lang` Ar or En, `userName`, `apiKey`, `number`, `userSender`) returns an `id` that a verify call later uses. **Questify will not use it**: we create, hash and check our own codes (expiry, attempt limits, email fallback FR-1812) and only use `sendsms.php` to deliver the text. This keeps the gateway replaceable (ADR-103).
- **Balance check:** `GET /gw/Credits.php` (used by health checks and the usage view).
- **Free test:** sender `auth-mseg` with a fixed text such as `Pin Code is: 1234` or `رمز التحقق: 1234`; any other content returns error 1064 until the sender is activated.
- **Two senders, matching ADR-065:** a whitelist sender for login codes and invites (service), and a promotional sender whose name ends in `AD` for opted-in promotions (error M0030 if the `AD` ending is missing).
- **Points:** every SMS is one point per segment. English: 160 characters (153 when split). Arabic or any non-English text: **70 characters (67 when split)**. Keep the login text short, for example `رمز كويستفاي: 482913`. A premium account (priority delivery with rerouting) costs 1.4 points per message.
- **Static IP:** the API can reject calls not coming from a registered IP (error M0037). Either give the API server a fixed outbound address on the chosen host, or switch the check off in the account settings.
- **Errors worth handling:** 1060 balance is not enough (alert), 1061 duplicate message, 1110 sender name wrong, 1120 bad number or international messaging off, 1140 message too long, M0008 bad prefix, M0090 template mismatch (when templates are enabled).
- **Secrets:** `apiKey` lives in the cloud secret store, one key per environment; test with `auth-mseg` in staging.
- **Not found in the public docs (ask Msegat):** delivery-receipt callbacks, rate limits per second, exact quote for 20,000 logins, and whether OTP priority routing is worth the 1.4x cost for our case.

## Email

- **Purpose:** email login codes (the fallback in FR-1812), staff codes (ADR-078), invites, invoices
  sent from outside the platform, opted-in promotions with unsubscribe (ADR-065).
- **Choice:** open (Q-034). Preference order: the chosen cloud's own email-sending service, so the
  address stays inside Saudi; otherwise a Saudi-based provider; a foreign provider such as Amazon SES
  or Postmark only after counsel agrees, and it would be added to the data map (NFR-020).
- **Failure behavior:** one retry; bounces and complaints come back through signed callbacks and
  suppress the address. A provider outage leaves SMS login working.
- **Data and PII:** email address and the code text.

- **Staff email, current choice (ADR-112, 2026-10-20):** `questify@nafes.com` in nafes.com's Google Workspace,
  sent through the Gmail API by a service account with domain-wide delegation (`gmail.send` only); nafes.com
  already has SPF, DKIM and DMARC. Resend stays the backup. Setup steps: `RUNBOOK.md`, "Email sending". The SMTP
  sender and its app password were removed with T-021.
- **Staff sign-in codes, stop-gap (2026-10-19, superseded by ADR-112):** Gmail SMTP (a **dedicated** Google account with an
  app password, never a personal mailbox) as the primary and Resend as the backup. Both are foreign providers
  that see staff email addresses and codes, so this is a **time-limited exception** to the in-region preference
  above: it goes in the data map (NFR-020) and the counsel batch (T-807), and the final choice is Q-083. Resend
  sends only from an address on a verified domain (SPF and DKIM), so it stays off until a domain exists.
  Timeouts: 5 s per sender, 8 s for the whole attempt; the same code goes to both senders.

## Push (APNs and FCM)

- **Purpose:** announcements, rank alerts, reminders (ADR-065).
- **Chosen because:** these are the only ways to reach a locked phone. We call them **directly** from
  the notification layer instead of through a relay service, so notification text does not also pass
  through a third party (ADR-086).
- **Auth and secrets:** APNs `.p8` key and the FCM service account in the secret store. Configuration (read by T-501b's
  clients, all-or-none per provider; a partial or malformed set refuses to start): `APNS_KEY_ID`, `APNS_TEAM_ID`,
  `APNS_PRIVATE_KEY` (the `.p8` PEM or its base64), `APNS_TOPIC` (the bundle id); `FCM_SERVICE_ACCOUNT` (the JSON or its
  base64). None set: the server starts, builds no provider, and in production logs `push.provider_missing {platform}`
  once per start (built in T-501: until T-501b both platforms log it and every push expires into the center unsent).
- **Failure behavior (T-501 plan, ADR-345):** APNs 410 `Unregistered` and FCM `UNREGISTERED` remove the
  token; the ambiguous token answers do too unless most of a round returns them, which holds that target instead. A
  definite 500 or 503 is requeued and sent again under the same collapse id until the message expires; a breaker holds
  a failing target from 30 s up to 15 minutes; only a timeout after the request was written is recorded as unknown and
  never resent. The notification center in the app always holds the message (F-200).
- **Data and PII:** device token and message text go through Apple and Google, who are outside Saudi.
  The text carries no phone, email or points detail beyond what the player has chosen to receive; this
  is on the counsel list with the wallet data (Q-043).

## Wallet passes (Q-076)

- **Apple:** a Pass Type ID and signing certificate come from the Apple developer account (the
  personal account stays, ADR-010). **Creating the certificate does not need a Mac:** a private key and
  signing request can be made with OpenSSL on Windows and uploaded in the browser. Passes are signed
  on our server (`passkit-generator`); updates use Apple's web service plus a push to the registered
  device. Rotating codes are not possible; the fixed ID code of ADR-091 is used.
- **Google:** a pass class and objects through the Wallet API, signed JWT links.
- **Failure behavior:** if signing fails or the certificate expired, "Add to Wallet" shows a short
  message and the in-app pass still works. Certificate expiry is an alert.
- **Open:** that Apple allows an organizer's logo on a pass signed by Questify is **the user's
  statement and has not been checked** against Apple's current review rules.

## Device integrity

- Apple App Attest and Google Play Integrity feed a fair-play flag only; they never block a player
  (ADR-041). If the service is unreachable, the flag is simply not raised.

## Install referrer and the iPhone join (Q-070)

- Android: the Play Install Referrer carries the join code through the store.
- iPhone: Firebase Dynamic Links shut down on 25 August 2025. Paid link services (Branch,
  AppsFlyer, Adjust) send data to third parties and conflict with PD-27's no-tracking rule.
  Fingerprint matching by IP is unreliable at a venue where many phones share one network.
  **Proposal:** the event page copies the join link to the clipboard when the player taps "Get the
  app"; after install, a "Paste event code" button reads it on tap (no hidden clipboard read). If
  missing, the player types or scans the short code once. Not yet confirmed (Q-070 stays open).

## Expo EAS

- Builds, submission and optional fixes. No personal data. If the free plan's slow queue is a
  problem near a release, the $19 plan gives a priority queue. A borrowed Mac with Xcode is the
  fallback if a cloud build fails for a reason only Xcode shows.

## Hosting options compared (2026-10-19, research only; Q-031 still open)

| Option | Where | Managed PostgreSQL | Fits ADR-070 (data in Saudi) | Main reason to pick | Main reason not to |
|---|---|---|---|---|---|
| Oracle Cloud | Riyadh, Jeddah | Yes (backups to 35 days, point-in-time restore, backup copy to the other Saudi city, replicas; 99.99% multi-node SLA published). **Availability in these two regions not yet seen in the console** | Yes | Best documented match for the 5-minute data-loss and 1-hour recovery targets; direct sign-up; CST Class C; Email Delivery in every region | One availability domain per region; console learning curve |
| Google Cloud | Dammam | Yes | Yes | 3 zones; strong tooling | A Saudi-billed company must buy through CNTXT (invoiced billing); more paperwork |
| sccc (Alibaba Cloud) | Riyadh, 2 zones | ApsaraDB RDS for PostgreSQL, Redis | Yes | Local billing and support; hyperscale scale; CST Class C | Alibaba-style console; buy through sccc; smaller English community |
| Huawei Cloud | Riyadh, 3 zones | Database services listed | Yes | 3 zones; CST Class C | Fewer examples for a TypeScript/Postgres stack |
| stc Cloud, SITE, Mobily, Sahara Net and other CST-registered local providers | Riyadh, Jeddah (Tier IV) | Mostly virtual machines you run yourself | Yes | Cheapest compute; local support | You run PostgreSQL, backups, failover and monitoring yourself |
| CranL | Riyadh, Jeddah (**Pro plan, $9.99 a month**); also Germany, Netherlands, US, Egypt, India | Yes (PostgreSQL, Redis, MySQL, MongoDB; backups; snapshots) plus S3-compatible buckets, CDN, realtime, cron, email, CLI and MCP for Claude | Yes, if its Riyadh/Jeddah servers are truly in-Kingdom | Fastest to deploy and cheapest; designed for AI-driven builds | Small vendor: HA, point-in-time restore, backup copies, SLA, host provider and CST status are **not published**; ask in writing (list in the chat) |
| Supabase (managed) | AWS regions; **no Middle East region** (nearest Mumbai or Frankfurt) | Yes | **No** | Nice developer tools | Breaks ADR-070; logs, backups and edge run outside the region |
| Supabase (self-hosted) | Wherever you run it | You run it | Yes, on a Saudi host | Supabase pieces for free | You lose managed backups, point-in-time restore and high availability; adds many services (auth, gateway, storage) we do not use because Questify has its own API |
| Ordinary VPS abroad (Hetzner, DigitalOcean, AWS Bahrain/UAE) | Outside the Kingdom | Self-run or managed | **No** for personal data | Cheap and easy | Fails residency; fine only for staging with fake data |
| AWS Saudi, Azure Saudi | Announced for December 2026 / Q4 2026 | Later | Not yet | Brand names | Not live; cannot plan a launch on them |

Claude's lean: **production on Oracle (Riyadh main, Jeddah recovery) once the console confirms PostgreSQL and the cache there; staging, rehearsal and demos on CranL Pro in Riyadh.** The server is plain containers plus PostgreSQL, so moving between hosts later is a data migration, not a rewrite. If Oracle's console lacks PostgreSQL in Riyadh, the next candidates are sccc or Google Dammam. Questions for CranL before trusting it with production: who runs the Riyadh and Jeddah hardware; is it in-Kingdom; automatic backups and how often; point-in-time restore; copy of backups to a second city; HA failover for a managed PostgreSQL; the written uptime commitment; maximum database size and connections; and its CST registration or hosting partner's.

## CranL staging (built 2026-10-19)

- **Project:** Nafes, region `riyadh-1` (Riyadh). **Apps:** `questify-api-staging` (Dockerfile build from the public repository, port 3000), live at https://questify-api-staging-3ez01s.cranl.net/healthz. **Databases:** `questify-db` (PostgreSQL), `questify-cache` (Redis). Database hosts are internal names, not reachable from the internet (checked: name does not resolve from outside).
- **Deploys** are manual: the app is created from a public Git URL, so CranL has no GitHub webhook. A GitHub Actions deploy job using a CranL API key kept as a repository secret is part of T-017.
- **Backups:** CranL database snapshots save only `public`-schema rows, 7 days, no restore of roles, policies or functions, no point-in-time recovery. See the ADR-107 addendum. A scheduled `pg_dump` to a second Saudi location is T-019.
- **Access:** the CranL command line is signed in as the account that owns Nafes and the B7R App organization. Questify work uses only the Nafes project, selected per command with the `CRANL_PROJECT` setting, never as the saved default.

