# T-409 — Questify invitations to chosen players, results counts, billed on the web

Delivers FR-738, FR-739, FR-740 (and the sender half of FR-1111, FR-1112, FR-1114, FR-1738 for invitations). Depends on
T-407 (consent, `player_preference`, `promoSendTime`, `optOutUrl`), T-210 (activation precedent), T-306b/T-402b (the
in-process tick and lease pattern). Choices are **Proposed ADR-329 to ADR-333 / Q-298 to Q-302**. Never push, deploy,
run EAS or run local mutation testing. CranL runs migrations through 0056; this is **0073** (new file).

**Bar: CORE** (consent gate, player privacy, tenant isolation, admin powers). Plan review and code review; mutation on
GitHub for the files below.

## Split (ADR-329)

| Task | Bar | What |
|---|---|---|
| **T-409** | **CORE** | Migration 0073, `apps/api/src/invitation-campaigns/` (doors' wrappers, the sender tick, the message), the promotional Msegat sender, organizer, console and public routes, shared schemas, the `invitationCampaigns` switch, the consent language, an app guard test (FR-740). |
| **T-409b** | Standard (web) | Dashboard Invitations page per event, console Invitations queue and detail, the landing page `/[lang]/i/[token]`. |

No app screen exists for this feature (FR-740).

## Decisions

### Billed on the web (ADR-329, Q-298 for Dhia)

ADR-076 keeps prices, invoices and payment off the platform, so "billed on the web" means: the **owner requests** a
campaign in the web dashboard; the Questify team agrees the price with the organizer outside the platform; a **Questify
admin approves** it in the console with the channels, a **message cap** and a send time, or refuses it with a note. No
price, invoice, VAT or payment field exists anywhere; the dashboard says "Nothing is charged here: the Questify team
contacts you about the price before approving." The mobile app has no invitation screen, link or purchase (PD-22).
FR-740 gains a clarification line in SRS (build): "confirmed" = the admin's approval; the charge is the off-platform
invoice of ADR-064/076. No add-on gate: the approval is the commercial gate.

### Campaign model (ADR-330)

- **Who:** the organizer's **owner** requests and cancels (commercial, like activation requests, ADR-077); owners and
  editors in scope read results. Admins approve, refuse and cancel.
- **Which events:** status `scheduled` or `live`, `ends_at` at least 24 h ahead, `access` public or unlisted, `'link'`
  in `join_methods`, not `guest_list_only`, no `email_domains` (the invitee must be able to join from the link at once;
  private events are left out, Q-299). Checked at request, at approval and again at the start.
- **One open campaign per event** (`requested`, `approved` or `sending`), so probing and spam need a fresh admin
  approval each time.
- **Criteria** (all optional, ANDed): `cityId` (one city), `interests` (0 to 3 catalog ids, any of, the player's stated
  `player_preference.interests` only), `history`: `none` | `recent` (a non-pending, non-declined enrollment in any event
  joined in the last 365 days) | `own` (such an enrollment in another event of this organizer). Never a named event of
  another organizer.
- **Size:** the owner asks for `size` (50 to 100,000); the admin sets the `cap` (50 to 100,000), the hard maximum of
  messages. The owner may give `sendAfter` (optional, before the event's end).
- **States:** `requested → approved → sending → sent`; `requested → refused` (admin, note required);
  `requested|approved → cancelled` (owner or admin); `sending → cancelled` (admin: unclaimed messages stop, claimed ones
  finish); `approved → cancelled` by the system at the start when the event no longer qualifies (`event_changed`) or
  fewer than 50 players match (`too_small`). `end_reason` ∈ `owner`, `admin`, `too_small`, `event_changed`.
- **Switch:** platform switch `invitationCampaigns`, **off when absent**; the request door refuses while off (the
  `questifyRanking` precedent, but default off because no channel can send until the "-AD" sender exists).

### Channels and message (ADR-331, Q-300)

- **Now: SMS only**, from a promotional Msegat sender (`MSEGAT_PROMO_SENDER`, the registered "...-AD" name, FR-1112),
  a second `createMsegatSender` instance; the service sender never carries a promotion. Unset → SMS is unavailable and
  the admin cannot approve it (`channel_unavailable`). **Push** joins with T-501 (opened = the notification opened, the
  app reports it). **Email** waits: a promotional sender separate from the sign-in mailbox, `List-Unsubscribe` headers
  and the provider's residency are T-706's call (TASKS note), so `availableChannels(config)` returns `['sms']` or `[]`.
- **One message per player per campaign**, on the first approved channel the player is opted in on and reachable by
  (push, then email, then SMS: cheapest first). **At most one invitation per player per 7 days** across campaigns.
- **Fixed template, no organizer text** (the admin sees the rendered preview). Draft (ux-araby check in the build):
  - ar: `كويستفاي: أنت مدعو إلى {event}. التفاصيل والانضمام: {link}` + newline + `لإيقاف رسائل العروض: {optOut}`
  - en: `Questify: you're invited to {event}. Details and joining: {link}` + newline + `Stop offers: {optOut}`
  - `{event}`: the name in the message's language, else the other, trimmed to 40 characters (`...`); `{link}`:
    `https://questify.sa/{lang}/i/{token}`; `{optOut}`: `optOutUrl(keys, {playerId, channel}, lang)`. Test bound: at
    most 4 SMS segments for any name (UCS-2 67, GSM-7 153 per part).
- **Language:** the language of the player's latest consent row on that channel. `marketing_consent` and
  `marketing_state` gain `language` (`ar`/`en`, null for rows before 0073 → Arabic); `PUT /v1/me/marketing` passes the
  request's `accept-language` (the app sends it on every call) to `set_marketing`. Also strengthens consent proof (the
  wording's language).
- **One consent predicate (amends ADR-318 (1)):** a new internal `promo_pool(ch, city, any_of)` holds the rule (active,
  `marketing_adult`, opted in on `ch` now, a phone for SMS, an email for email); `marketing_audience` is restated over it
  **and restricted to system context** (it returns player ids and was callable from any request context); the invitation
  fill reads `promo_pool` too.

### Results without identifying anyone (ADR-332, Q-301)

- **Sent** (organizer) = `sent + unknown` (handed to the provider, maybe delivered). Admin sees each state exactly.
- **Opened** = the invitation link opened: the landing page `/[lang]/i/[token]` POSTs the token from the browser on
  load (`POST /v1/public/invitation-open`), which marks the recipient's `opened_at` once. First-party, no pixel, no SDK,
  no third party (PD-27); a GET-only link preview does not count. Forwarded links count as the recipient's open. Push
  opens arrive with T-501. The page sets `referrer-policy: no-referrer` and `noindex`. Privacy policy line owed (T-807).
- **Joined** = a recipient (sent or unknown) who has an enrollment in the event, not `pending` or `declined`, with
  `joined_at ≥` their `sent_at` (set at the claim, the hand-off moment), found by the settle step until the event ends or 30 days after sending finished
  (whichever first). Server-side only: the landing page's button is the plain join link (`/{lang}/e/{code}`, via
  `link`); **no enrollment is marked as invited**, so the member list never shows who came from a campaign.
- **Organizer numbers** come only from `published_*` columns, refreshed once a Questify day (first settle after 04:00
  Riyadh) and at the final close, and are **bucketed in SQL**: below 10 → `{fewerThan: 10}`, else
  `{atLeast: floor(n/10)*10}`. Exact counts never leave the database for an organizer. A campaign with **fewer than 50
  recipients is not sent** (`too_small`). Together: no organizer answer names or numbers a group under 10, sends never
  target fewer than 50, and the daily delay blurs the link between a count's change and the member list's join times.
- **Audit rows readable by organizers** (`audit_read` lets an organizer read its own rows) carry states, criteria, size,
  cap and send time only, **never a count**; system rows (start, finish, final) carry none either. Admins read exact
  counters through the console door.
- **Retention:** recipient rows are deleted 90 days after sending finished (after the results are final); counters stay
  on the campaign. Erasure deletes a player's recipient rows at once (`erase_rows` restated); counters never decrease.

### Sending (ADR-333, Q-302)

- **The in-process tick pattern** (souvenirs, community: jittered `setTimeout`, `unref`, `stop` awaited on close), not
  pg-boss (not installed; T-501 may introduce it). Every 5 s, budget 3 s: (1) start one due campaign; (2) claim up to
  50 recipients, send with concurrency 5, ack each; release what the budget left; (3) every 10 minutes, settle.
- **At most once.** Claim sets `sending` with a 60 s lease (`FOR UPDATE SKIP LOCKED`); a lease that expires in
  `sending` becomes `unknown` and is **never resent**. Msegat has no idempotency key; the sender's own retry only covers
  "never left" errors (existing `NEVER_LEFT`).
- **Outcomes:** `sent` → sent; `unknown` (timeout, unreadable) → unknown; `refused` for the number (INTEGRATIONS'
  number codes) → failed; `refused` for the account (balance, sender, IP, `unreachable`) → the row goes back to queued
  (attempts + 1, the third → failed) and the campaign gets `hold_until = now() + 15 min` and log
  `invitation.provider_hold {code}`: the fallback is to wait, never another channel or sender.
- **Quiet hours (FR-1738):** at approval the API moves `sendAt` with `promoSendTime('sms', sendAt)` and says so
  (`sendAtMoved`); at each claim SMS is allowed only when `isPromoSmsAllowed(now)` and `isPromoSmsAllowed(now + 60 s)`
  (the lease's margin); otherwise rows wait until 09:00 (12:00 in Ramadan).
- **Re-checked at claim, per row:** still opted in on the channel, active, adult, reachable, not enrolled in the event,
  the event not ended; else `skipped` (`opted_out`, `gone`, `no_contact`, `member`, `event_over`). An opt-out is
  effective for every unsent row at once.
- **Fills are serialized** by `pg_advisory_xact_lock(hashtext('invitation_fill'))`, so two instances cannot pick the
  same player past the 7-day cap.
- No outside call runs inside a database transaction. Contact and text never reach a log, an audit row or an error.

## Migration 0073 (new file)

`SET LOCAL lock_timeout = '10s'`; `LOCK TABLE marketing_consent, marketing_state IN ACCESS EXCLUSIVE MODE` (ADD
COLUMN); `event`, `player`, `city`, `staff_user` in SHARE ROW EXCLUSIVE (foreign keys). Never `ledger_entry`,
`enrollment` (read only), `xp_entry` or `platform_setting`. Deny by default: both new tables RLS enabled and forced,
`REVOKE ALL FROM PUBLIC, questify_app`, no policy; every function `SECURITY DEFINER SET search_path = public, pg_temp`,
`REVOKE ALL ... FROM PUBLIC` in its own statement group; only doors granted to `questify_app`. SQL codes `IV***`.

```
invitation_campaign(
  id uuid PK, organizer_id, event_id, FK (event_id, organizer_id) → event ON DELETE CASCADE,
  request_id uuid UNIQUE NOT NULL, fingerprint text NOT NULL,            -- the souvenir_replay precedent
  requested_by → staff_user SET NULL, requested_at,
  city_id → city NULL, interests text[] (≤3, catalog), history text IN (none, recent, own),
  size int 50..100000, send_after timestamptz NULL,
  state text IN (requested, approved, sending, sent, cancelled, refused),
  channels text[] NULL ⊆ {push, sms, email}, cap int NULL 50..100000, send_at timestamptz NULL,
  admin_note text NULL (1..500), decided_by → staff_user SET NULL, decided_at,
  started_at, finished_at, final_at, hold_until, end_reason text NULL,
  planned, sent, unknown, failed, skipped, opened, joined int ≥ 0 DEFAULT 0,
  published_sent, published_opened, published_joined int NULL, published_at,
  shape CHECKs: approved/sending/sent ⇒ channels, cap, send_at; refused ⇒ admin_note; cancelled ⇔ end_reason)
UNIQUE (event_id) WHERE state IN ('requested','approved','sending');  INDEX (state, send_at)

invitation_recipient(
  id uuid PK, link uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),       -- the bearer token in the message
  campaign_id → invitation_campaign ON DELETE CASCADE, player_id → player RESTRICT,
  channel text, state text IN (queued, sending, sent, unknown, failed, skipped, cancelled),
  lease_token uuid, lease_until, attempts smallint, error_code text (provider code only), skip_reason text,
  created_at, sent_at, opened_at, joined_at, UNIQUE (campaign_id, player_id))
INDEX (campaign_id) WHERE state = 'queued';  INDEX (player_id, created_at)
```

**Restated:** `marketing_consent ADD language`, `marketing_state ADD language`; `marketing_state_apply` (copies it);
`set_marketing` DROP + CREATE `(channels jsonb, how text, version text, lang text)` (MK422 `language`); `marketing_audience`
(plpgsql, MK403 outside system context, over `promo_pool`); `erase_rows` (0070 body + `DELETE FROM invitation_recipient`).

**Internal (no grant):** `promo_pool`, `invitation_system_only()` (`ranking_system()`, no device, READ COMMITTED; IV403),
`invitation_event_ok(event)` (returns the reason or null), `invitation_criteria_ok(...)`, `invitation_candidates(campaign)`
(the fill and estimate query: `promo_pool` per approved channel, `DISTINCT ON (player)` by channel order, criteria,
history, no enrollment in the event in any status, no live recipient row (`queued`, `sending`, `sent`, `unknown`) for
this event or created in the last 7 days; ordered by `md5(campaign_id || player_id)`), `invitation_bucket(n) → jsonb`,
`invitation_audit(...)`. The `accept-language` value reaches `set_marketing` as `ar` or `en` (Arabic when absent or
other).

**Doors (granted to `questify_app`):**

| Door | Caller | Notes |
|---|---|---|
| `invitation_request(event, body jsonb, request)` | owner (IV403 `owner_only`; another tenant's event IV404) | switch on (IV403 `feature_off`), event rule (IV409 `event_not_eligible` + reason), one open (IV409 `invitation_open`), criteria (IV422 + field); replay by `request_id`, different body IV409 `idempotency_mismatch`; audited `invitation.request` |
| `invitation_cancel(campaign, request)` | owner | requested or approved, else IV409 `wrong_state`; audited |
| `invitation_list(event)` | owner, editor in scope | campaigns newest first (≤ 50): criteria, size, state, cap, sendAt, note, end reason, bucketed published counts and `publishedAt`; nothing exact |
| `invitation_admin_queue()` | admin (`questify_admin`, QY403) | open campaigns first, then the latest 100 closed; organizer and event names |
| `invitation_admin_get(campaign)` | admin | exact counters, per-channel audience estimate (count of `invitation_candidates`), the event card for the preview |
| `invitation_approve(campaign, channels, cap, send_at, note, request)` | admin | requested only; channels non-empty; cap and send_at bounds (now − 1 min ≤ send_at ≤ event end − 1 h); event rule again; audited (no counts) |
| `invitation_refuse(campaign, note, request)` / `invitation_admin_cancel(campaign, note, request)` | admin | as above; admin cancel of `sending` marks queued rows `cancelled` under the campaign's row lock |
| `invitation_start_due()` | system | under the fill lock: the oldest approved campaign with `send_at ≤ now()`: event rule (else cancelled `event_changed`), fill up to `cap` (fewer than 50 → no rows, cancelled `too_small`), else `sending`, `planned`, `started_at`; audited without counts |
| `invitation_claim(allowed text[], batch)` | system | locks due campaigns `FOR SHARE` (an admin cancel waits), expires leases to `unknown`, re-checks each row (skips), leases the rest; returns recipient id, lease, channel, language, contact, player id, event names and join code |
| `invitation_ack(recipient, lease, outcome, code)` / `invitation_release(ids, leases)` | system | lease must match (else no-op); counters move with the state; `hold` requeues and holds the campaign |
| `invitation_settle()` | system | joined pass, finish (`sent` when nothing queued or sending), final (event end or 30 days), daily publish, purge (5000 rows a call), cancel requested/approved campaigns whose event ended |
| `invitation_open(link)` | any (public route) | first open sets `opened_at` and `opened + 1`; returns the public event card or null (unknown, purged, event over); never player data |

## API

| Route | Auth | Notes |
|---|---|---|
| `GET …/events/{eventId}/invitation-campaigns` | owner, editor | `{enabled, campaigns}`; counts as `{fewerThan: 10} \| {atLeast: n} \| null` |
| `POST …/events/{eventId}/invitation-campaigns` | owner, Idempotency-Key | `{cityId, interests, history, size, sendAfter}` → 201 `{campaign}`; 403 `owner_only`/`feature_off`, 404, 409 `invitation_open`/`event_not_eligible {reason}`, 422 `invalid_invitation {field}` |
| `DELETE …/invitation-campaigns/{campaignId}` | owner | → 204; 404, 409 `wrong_state` |
| `GET /v1/admin/invitation-campaigns` and `/{id}` | admin | the queue; the detail with exact counts, estimate per channel, `availableChannels`, and the rendered messages (ar, en, segments) |
| `POST /v1/admin/invitation-campaigns/{id}/approve` | admin, Idempotency-Key | `{channels, cap, sendAt, note?}` → `{campaign, sendAtMoved}`; 409 `wrong_state`, 422 `invalid_approval {field}` / `channel_unavailable {channel}` / `event_not_eligible` |
| `POST …/{id}/refuse`, `POST …/{id}/cancel` | admin, Idempotency-Key | `{note}` |
| `POST /v1/public/invitation-open` | anonymous | `{token}` (22-char base64url of `link`) → 200 `{event}` / 404 `invitation_ended` / 400 malformed; throttled per address (the opt-out route's limiter) |

All `no-store`. Every new code gets Arabic and English messages (`http-errors.ts`, `messages.ts`); Western digits.

## Tests

- **DB (`test/db/invitation-campaigns.int.test.ts`):** request (owner only; editor, limited editor and another
  organizer refused; every event-rule reason; criteria bounds; one open; replay and mismatch; switch off); approve,
  refuse, cancel (states, bounds, admin only); fill (opted out, other channel only, minor, banned, deleted, no phone,
  each criterion, `recent`/`own`, enrolled in any status, invited to this event before, the 7-day cap, the cap and its
  per-campaign order, channel order, `too_small`, `event_changed`, two fills at once); claim (system only from player,
  staff, admin and device contexts; skips for each reason; quiet-window channels; lease expiry → unknown never resent;
  two claimers disjoint; cancel during claim); ack and release (lease mismatch, each outcome, attempts, hold); open (once,
  unknown, purged, event over, answer has no player field); settle (joined only after `sent_at` and not pending, once;
  finish; final; daily publish; purge); erasure (rows gone, counters kept); language recorded and copied; restated
  `marketing_audience` refused outside system context. **Organizer answers never carry an exact count** (a property test
  over random counters: every number is null or a multiple of 10 ≥ 10); no organizer-readable audit row has a count.
- **Security:** outsider (every new function no PUBLIC; the exact `questify_app` grant list; no table rights on the two
  tables), cross-tenant (both tables' entries; organizer B and a limited editor see 404 for A's campaign), routes
  inventory, `test/db/marketing.int` updated for the new `set_marketing` and `marketing_audience`.
- **Timing (by hand, recorded in ADR-333):** fill and estimate at 100,000 opted-in players; gate 2 s for the fill (the
  API's statement limit is 5 s, `pool-options.ts`).
- **Unit:** message (both languages, fallback name, trimming, both links present in every message, ≤ 4 segments, Western
  digits), sender outcome mapping, tick (budget, release, quiet window with the margin, hold, stop), routes (shapes,
  refusals, idempotency), schemas. **App:** a guard test that no `apps/app` file names the `invitation-campaigns` routes
  (FR-740; the `event-isolation.test` precedent).
- Full `npx vitest run` once with both URLs before reporting.

## T-409b (standard, web)

Dashboard: Invitations per event (shown when the switch is on): list with state and counts ("120+", "Fewer than 10",
"Updated daily"), the request form (city, up to 3 interests, history, size, earliest send), owner-only actions with the
owner note (update the count in `e2e/organizers.spec.ts`), the "nothing is charged here" and "you see only counts, never
who" lines. Console: queue, detail with estimate, preview, approve (channels limited to available ones; the moved time
shown), refuse, cancel. Landing page `/[lang]/i/[token]`: POST on load, event card, "Open in Questify" (join link),
"This invitation has ended". Every string in both languages through ux-araby; RTL; phone width. Browser specs for the
three surfaces.

## Docs the build updates

API.md, DATA_MODEL.md (both tables; `invitation_recipient` is personal data, 90-day retention), SECURITY.md (a T-409
boundary section), SRS (FR-738 to FR-740 status, FR-740 clarification), CONFIGURABILITY.md (the switch; 50, 10, 7 days,
30 days, 90 days are code constants until T-703's tuning), RUNBOOK (`MSEGAT_PROMO_SENDER`, turning the switch on),
STORE_COMPLIANCE (PD-22 holds; the opened-link line for the privacy policy, T-807).

## Mutation globs (core, GitHub only)

`apps/api/src/invitation-campaigns/**/*.ts`, `packages/shared/src/invitation-campaigns/**/*.ts`,
`apps/api/src/marketing/marketing.ts`, `apps/api/src/marketing/routes.ts`.

## Risks for the reviewer

1. Re-identification by joining the counts with the organizer's member list (buckets, 50, daily publish, no marker).
2. At-most-once: a crash after Msegat accepts and before the ack counts as `unknown`, never resent; is that the right
   side to fail on for a paid promotion?
3. The quiet window is enforced in TypeScript (the claim's `allowed`), not in SQL.
4. Restating T-407's `set_marketing` (signature) and `marketing_audience` (system only).
5. Erasure or opt-out racing a claim: a message can still leave within seconds of the change (inside FR-1738's 24 h).
6. SMS length with two links (4 segments in Arabic) and its cost.
7. Hot campaign row: every ack and open updates the counters.
