# T-409 — Questify invitations to chosen players, results counts, billed on the web

Delivers FR-738, FR-739, FR-740 (and the sender half of FR-1111, FR-1112, FR-1114, FR-1738 for invitations). Depends on
T-407 (consent, `player_preference`, `promoSendTime`, `optOutUrl`), T-210 (activation precedent), T-306b/T-402b (the
in-process tick and lease pattern). Choices are **Proposed ADR-329 to ADR-333 / Q-298 to Q-302**. Never push, deploy,
run EAS or run local mutation testing. CranL runs migrations through 0056; this is **0073** (new file).

**Bar: CORE** (consent gate, player privacy, tenant isolation, admin powers). Plan review and code review; mutation on
GitHub for the files below. **The code review checks MAJOR 1 and MAJOR 2 of the second review explicitly** (§ Finding 1,
§ Finding 2: each rule has its named test).

## First plan review (84, NO-GO until 1 and 2)

| # | Finding | Where it is now |
|---|---|---|
| 1 BLOCKER | A rename after approval changed the SMS | § Finding 1 (names copied at approval and the text rendered only from the copy) |
| 2 MAJOR | Rows stuck after a cancel | § Finding 2 |
| 3 | Claim size | Sending: rounds of 5; no release door |
| 4 | Account refusals | Sending: one hold for the SMS channel, no further round, no attempt counted, alert |
| 5 | Locks | § Lock order (goes into `docs/rules.md` with the build) |
| 6 | `promo_pool` | Plain `LANGUAGE sql STABLE`, no definer, no `SET`; the claim names it as the consent rule |
| 7 | Quiet hours in SQL | `invitation_claim` refuses SMS 22:00–09:00 Riyadh itself |
| 8 | 7-day limit | `queued`/`sending` always count; `sent`/`unknown` when `sent_at` is within 7 days |
| 9 | Deploy | `set_marketing(..., lang text DEFAULT NULL)`, NULL read as Arabic; RUNBOOK deploy note |
| 10 | ADR-332 wording | Reworded; T-807 line; public events only |
| 11 | Token in the URL | Fragment `/{lang}/i#{token}`; own rate-limit bucket |
| 12 | Switch | RUNBOOK: on only after T-409b, the T-807 line and the Q-034 sender; off stops start and claim |
| 13 | SMS length | Shorter Arabic, no brand prefix, 3 parts at most; preview with a placeholder token |
| 14 | Channels | SMS only in v1; `channels` column kept; T-501 adds the order between channels |
| 15 | Fill lock | `pg_try_advisory_xact_lock` |
| 16 | Mutation | `!**/*.test.ts`; the build adds the globs to `stryker.config.json` |

## Second plan review (86, NO-GO until MAJOR 1 and 2)

| # | Finding | Where it is now |
|---|---|---|
| MAJOR 1a | The admin could approve text never seen | § Finding 1 (a): approve takes `expectedNameAr/En`, IV409 `event_renamed` when they differ; test "preview, rename, approve → 409" |
| MAJOR 1b | The name rule missed obfuscations | § Finding 1 (b): NFKC, no `\p{Cc}`/`\p{Cf}`, no dot-like character between letters or digits, no run of 9+ digits, also on the trimmed text, `\y` not `\b`; the admin approving the exact text is the real gate |
| MAJOR 2 | Queued rows could stay queued forever | § Finding 2, last rows: settle (running with the switch off) skips a `sending` campaign's queued rows once its event is over and finishes it `sent` with `end_reason = 'event_over'`; test "switch off, event ends, settle → `sent`, purged after 90 days" |
| 5 | Lease expiry lock order; late ack | Sending and § Lock order: campaigns `FOR NO KEY UPDATE ORDER BY id` first, then rows; expiry clears `lease_token`; ack needs `state = 'sending' AND lease_token = $lease` |
| 6 | Ramadan window | Sending: SMS allowed only outside both bands (22:00–09:00, and 01:00–12:00 in Ramadan: 22:00–12:00 in all); approval moves against both; RUNBOOK corrected |
| 7 | Event changes mid-send; renames at start | Sending: the claim runs `invitation_event_ok` (minus the 24-hour rule) and skips `event_changed`; the start uses the copied names only |
| 8 | `joinedAt` in the member list | Results and ADR-332: a burst of joins after the send hints at who was invited on any event; T-807 line says so |
| 9 | Wording, sender check, T-407 note | Sending: "claims no further round"; startup refuses `MSEGAT_PROMO_SENDER = MSEGAT_SENDER`; TASKS' T-407 note marked superseded by ADR-331 (7) (the consent rule) |

## Split (ADR-329)

| Task | Bar | What |
|---|---|---|
| **T-409** | **CORE** | Migration 0073, `apps/api/src/invitation-campaigns/` (doors' wrappers, the sender tick, the message), the name rule in `packages/shared/src/invitation-campaigns/`, the promotional Msegat sender, organizer, console and public routes, shared schemas, the `invitationCampaigns` switch, the consent language, an app guard test (FR-740). |
| **T-409b** | Standard (web) | Dashboard Invitations page per event, console Invitations queue and detail, the landing page `/[lang]/i`. |

No app screen exists for this feature (FR-740).

## Decisions

### Billed on the web (ADR-329, Q-298, developer's call under ADR-076)

The **owner requests** a campaign in the web dashboard; the Questify team agrees the price outside the platform
(ADR-076, accepted by Dhia); a **Questify admin approves** it in the console with the channels, a **message cap** and a
send time, or refuses it with a note. No price, invoice, VAT or payment field exists anywhere; the dashboard says
"Nothing is charged here: the Questify team contacts you about the price before approving." The mobile app has no
invitation screen, link or purchase (PD-22). FR-740 gains a clarification line in SRS (build): "confirmed" = the
admin's approval; the charge is the off-platform invoice of ADR-064/076. No add-on gate: the approval is the commercial
gate.

### Campaign model (ADR-330)

- **Who:** the organizer's **owner** requests and cancels (commercial, like activation requests, ADR-077); owners and
  editors in scope read results. Admins approve, refuse and cancel.
- **Which events (v1):** **public events only** (unlisted and private are left out), status `scheduled` or `live`,
  `ends_at` at least 24 h ahead, `'link'` in `join_methods`, not `guest_list_only`, no `email_domains`. This is
  `invitation_event_ok(event)`, run at request, approval and start; the claim runs it without the 24-hour rule. Names are
  checked by the name rule (Finding 1), not by this function.
- **One open campaign per event** (`requested`, `approved` or `sending`).
- **Criteria** (all optional, ANDed): `cityId` (one city), `interests` (0 to 3 catalog ids, any of, the player's stated
  `player_preference.interests` only), `history`: `none` | `recent` (a non-pending, non-declined enrollment in any event
  joined in the last 365 days) | `own` (such an enrollment in another event of this organizer). Never a named event of
  another organizer.
- **Size:** the owner asks for `size` (50 to 100,000); the admin sets the `cap` (50 to 100,000), the hard maximum of
  messages. The owner may give `sendAfter` (optional, before the event's end).
- **States:** `requested → approved → sending → sent`; `requested → refused` (admin, note required);
  `requested|approved → cancelled` (owner or admin); `sending → cancelled` (admin); `approved → cancelled` by the system
  (`event_changed` at the start, `too_small` at the fill, `event_over` when settle finds the event ended before the
  start); `sending → sent` by settle, with `end_reason = 'event_over'` when the event ended with messages still queued
  (Finding 2). `end_reason` ∈ `owner`, `admin`, `too_small`, `event_changed`, `event_over`.
- **Switch:** platform switch `invitationCampaigns`, **off when absent**. Off: the request door refuses, and the tick
  neither starts nor claims (a kill switch); settle keeps running. RUNBOOK says when to turn it on.

### Channels and message (ADR-331)

- **v1: SMS only**, from a promotional Msegat sender (`MSEGAT_PROMO_SENDER`, the registered "...-AD" name, FR-1112),
  a second `createMsegatSender` instance; the service sender never carries a promotion. **`loadConfig` refuses to start
  when `MSEGAT_PROMO_SENDER` equals `MSEGAT_SENDER`** (case-insensitive). Unset → SMS is unavailable and the admin cannot
  approve it (`channel_unavailable`). The `channels` column stays (`{sms}` in v1); T-501 adds push and the order between
  channels; email waits for T-706's promotional email sender. `availableChannels(config)` returns `['sms']` or `[]`.
- **One message per player per campaign. At most one invitation per player per 7 days:** a player is skipped when they
  hold a recipient row in `queued` or `sending` (any campaign), or in `sent` or `unknown` with `sent_at` within 7 days.
- **Fixed template, no organizer text** (ux-araby check in the build; no brand prefix: the sender name "...-AD"
  identifies Questify; gender-neutral):
  - ar: `دعوة إلى {event}: {link}` + newline + `إيقاف العروض: {optOut}`
  - en: `Invitation to {event}: {link}` + newline + `Stop offers: {optOut}`
  - `{event}`: the campaign's **copied** name (Finding 1) in the message's language, else the other, cut to at most 40
    UTF-16 units without splitting a surrogate pair, then `...` when cut (`trimName`); `{link}`:
    `https://questify.sa/{lang}/i#{token}` (fragment, 22-char token); `{optOut}`: `optOutUrl(keys, {playerId, channel},
    lang)`. **Test bound: at most 3 SMS parts** for every 40-unit name in either script (UCS-2 67, GSM-7 153 per part;
    the longest Arabic case is about 190 characters).
  - The console preview renders the same template from the names it shows, with a placeholder token of the real
    length, never a real token.
- **Language:** the language of the player's latest consent row on that channel. `marketing_consent` and
  `marketing_state` gain `language` (`ar`/`en`, nullable); `set_marketing(channels, how, version, lang text DEFAULT
  NULL)` records it; `PUT /v1/me/marketing` passes `ar` or `en` from `accept-language` (the app sends it on every call).
  NULL (old rows, or an old 3-argument call during the deploy) is read as Arabic.
- **One consent predicate (amends ADR-318 (1)):** `promo_pool(ch, city, any_of)` is a plain `LANGUAGE sql STABLE`
  function (not a definer, no `SET` clause, so the planner can inline it; tables schema-qualified; no grant) holding the
  rule: active, `marketing_adult`, opted in on `ch` now, a phone for SMS. `marketing_audience` is restated over it and
  **restricted to system context**; the fill and the claim's re-check read `promo_pool` by name.

### Results (ADR-332)

- **Sent** (organizer) = `sent + unknown` (handed to the provider). Admin sees each state exactly.
- **Opened** = the invitation link opened: the landing page `/[lang]/i` reads the token from the fragment, clears it
  (`history.replaceState`, the `InviteFlow` precedent) and POSTs it (`POST /v1/public/invitation-open`), which marks
  `opened_at` once. A fragment never reaches a server log or a `Referer`; a GET-only link preview does not count.
  First-party, no pixel, no SDK (PD-27). Forwarded links count as the recipient's open.
- **Joined** = a recipient (sent or unknown) with an enrollment in the event, not `pending` or `declined`, with
  `joined_at ≥` their `sent_at` (set at the claim), found by settle until the event ends or 30 days after
  `finished_at` (whichever first). The landing page's button is the plain join link (`/{lang}/e/{code}`); **no enrollment
  is marked as invited**.
- **Organizer numbers** come only from `published_*`, refreshed once a Questify day (first settle after 04:00 Riyadh)
  and at the final close, **bucketed in SQL**: below 10 → `{fewerThan: 10}`, else `{atLeast: floor(n/10)*10}`. Exact
  counts never leave the database for an organizer. A campaign with **fewer than 50 recipients is not sent**.
- **What this does not promise:** the organizer sees the campaign's send date and state, and its member list shows every
  member's `joinedAt` in join order (`GET …/events/{eventId}/players`). So on **any** event, a burst of joins soon after
  the send hints at who was invited (and therefore opted in and matched the criteria); on a quiet event the joined count
  alone can. That comes with publishing a joined count at all (FR-739); the buckets, the minimum and the daily delay make
  it coarser, not impossible. The privacy policy states it (T-807 line, in ADR-332).
- **Audit rows** an organizer can read (`audit_read`) carry states, criteria, size, cap and send time, **never a
  count**; system rows (start, finish, final, hold) carry none either.
- **Retention:** recipient rows are deleted 90 days after `finished_at` once results are final; counters stay on the
  campaign. Erasure deletes a player's recipient rows at once (`erase_rows` restated); counters never decrease.

### Sending (ADR-333)

- **The in-process tick pattern** (souvenirs, community), not pg-boss. Every 5 s, budget 3 s, only while the switch is
  on: (1) start one due campaign; (2) **rounds of 5**: claim up to 5 recipients (the send concurrency), send them
  concurrently, ack each as it returns; claim the next round while the budget lasts. There is no release door: every
  claimed row is sent in its round. (3) Every 10 minutes, settle (**also while the switch is off**).
- **At most once.** Claim sets `sending` with a 60 s lease and a fresh `lease_token`. **Lease expiry** (in the claim and
  in settle): lock the affected campaigns first (`FOR NO KEY UPDATE ORDER BY id`), then their stale rows (`FOR UPDATE
  SKIP LOCKED`), set them `unknown` and **clear `lease_token`**. `invitation_ack` changes a row only when `state =
  'sending' AND lease_token = $lease`, so a late ack never rewrites an `unknown` row. An `unknown` row is never resent.
  Msegat has no idempotency key; the sender's own retry covers only "never left" errors.
- **Outcomes:** `sent` → sent; `unknown` (timeout, unreadable) → unknown; `refused` for the number (INTEGRATIONS' number
  codes) → failed; **`refused` for the account** (balance `1060`, sender `1110`, address `M0037`, `unreachable`) → **one
  hold for the whole SMS channel**: `invitation_channel_hold(channel, hold_until = now() + 15 min, code)`, the row goes
  back to `queued` (only while its campaign is `sending`; otherwise `cancelled`, Finding 2) with no attempt counted, and
  **the tick claims no further round** until the hold ends (the round's other messages are already in flight and are
  acked as they return); log `invitation.channel_hold {channel, code}` at error level (the RUNBOOK alert). No other
  outcome requeues a message, so no attempt counter exists and no account refusal ever fails a message.
- **Quiet hours (FR-1738), two bands:** the fixed band 22:00–09:00 Riyadh, and in Ramadan TypeScript's 01:00–12:00
  (`send-window.ts`), so **in Ramadan nothing goes 22:00–12:00**. `invitationSmsAllowed(at)` = `isPromoSmsAllowed(at)`
  and outside the fixed band; `invitationSmsTime(at)` = the first full hour from `at` where it holds. Approval moves
  `sendAt` with `invitationSmsTime` and says so (`sendAtMoved`); the tick passes SMS to the claim only when
  `invitationSmsAllowed(now)` and `invitationSmsAllowed(now + 60 s)`; **`invitation_claim` itself refuses SMS while the
  Riyadh hour of `now()` or `now() + 60 s` is in 22:00–08:59**, whatever the API passed (Ramadan stays in TypeScript).
- **Re-checked at claim, per row:** `EXISTS (SELECT 1 FROM promo_pool(r.channel, NULL, NULL) p WHERE p.player_id =
  r.player_id)` (the consent rule by name) else `skipped` `opted_out`; not enrolled in the event else `member`; the event
  not ended else `event_over`; **`invitation_event_ok(event)` without the 24-hour rule** else `event_changed` (made
  unlisted or private, guest-list-only, a domain lock, link joining off).
- **Start:** `pg_try_advisory_xact_lock(hashtext('invitation_fill'))`; a server that does not get it skips the fill this
  tick. The start runs `invitation_event_ok` and uses **only the copied names** (Finding 1), so a rename after approval
  never cancels a paid campaign.
- No outside call runs inside a database transaction. Contact and text never reach a log, an audit row or an error.

## Finding 1: the admin approves the exact text, and only that text is sent

**(a) Frozen at approval.** `invitation_campaign` gains `name_ar text`, `name_en text`. The console detail
(`GET /v1/admin/invitation-campaigns/{id}`) returns the event's current `names {ar, en}`, the name rule's verdict on
each, and the messages rendered from them. Approve sends back **`expectedNameAr` and `expectedNameEn`** (the names the
console showed; null where the event has none). `invitation_approve` takes the event `FOR SHARE`, compares them with
`event.name_ar`/`name_en` (`IS DISTINCT FROM`) and **fails with IV409 `event_renamed`** when either differs; otherwise
it copies them onto the campaign in the same transaction. `invitation_start_due` and `invitation_claim` use the copy;
**nothing in the sender reads `event.name_*`**. The landing page shows the live public event card (the ordinary public
page, not the SMS).

**(b) The name rule** (`invitationNameIssue(name)` in `packages/shared/src/invitation-campaigns/name-rule.ts`, the
`apps/api/src/organizers/naming.ts` precedent; JavaScript's `\p{...}` classes do not depend on the database's locale).
On `n = name.normalize("NFKC")`, refused when:

1. `n` contains a `\p{Cc}` or `\p{Cf}` character (U+200B, U+200E, U+202E, U+2066, U+FEFF and the rest of the class) →
   `control_characters`;
2. `n` contains `://` or `@`, or a dot-like character `[.。．｡․۔]` with a letter or digit of any script on both sides
   (`/[\p{L}\p{N}][.。．｡․۔][\p{L}\p{N}]/u`): no domain list → `looks_like_address`;
3. `n` with every character that is not `\p{L}` or `\p{N}` removed holds a run of 9 or more `\p{Nd}` digits of any
   script (`/\p{Nd}{9,}/u`; "Season 2026-2027" gives 8 and passes, "050 123 4567" and «٠٥٠١٢٣٤٥٦٧» give 10 and fail) →
   `looks_like_phone`;
4. any of 1–3 holds for `trimName(name)` (the 40-unit cut plus `...`, exactly as sent).

The API runs it at request (on the event's live names, for early feedback) and at approval (on `expectedNameAr/En`,
which the door then proves equal to the event's names): 422 `event_name {language, reason}`. The SQL holds no regex for
this; if any SQL regex in 0073 needs a word boundary it is `\y` (in Postgres `\b` is a backspace). **The rule is a
filter, not the gate: the admin approving the exact rendered text is the gate**, and spelled-out forms ("example dot
com", «مثال دوت كوم», digits written as words) are the admin's to catch; the console shows the full rendered message
next to Approve.

**Tests.** DB (`invitation-campaigns.int`): **"preview, rename, approve → 409"**: read the detail, `UPDATE event SET
name_ar` (as an editor would), approve with the previewed names → IV409 `event_renamed`, nothing copied; approve with
the new names → approved, the copy equals them. **"rename after approval sends the approved text"**: approve, rename
both names, start and claim → the claimed names are the approved ones, and `renderInvitation` on that claim gives the
approved text. Unit (`name-rule.test.ts`): every `\p{Cc}`/`\p{Cf}` code point (generated from JavaScript's own class,
not a hand list) is refused; `example.com`, `example。com`, `example．com`, `example｡com`, `example․com`, `مثال۔كوم`,
`x.y`, `a@b`, `http://x` refused; `St. Patrick`, `v2 . 0` and `Dr. Ahmed` pass; `Season 2026-2027` passes;
`050 123 4567`, `+966-50-123-4567`, the Arabic-Indic and the fullwidth forms refused; a 60-character
`...example.community` is refused and so is its cut `...example.com...` (both texts are checked); a 40-unit cut never
splits a surrogate pair. Route: approve with a refused name → 422
`event_name`.

## Finding 2: no row is left stuck

| Case | Rule | Named test |
|---|---|---|
| Account refusal (hold) on a row whose campaign is no longer `sending` | `invitation_ack` requeues only while the campaign is `sending`; otherwise the row becomes `cancelled` | "cancel mid-round, account refusal → row cancelled" |
| Any other outcome after a cancel | ack records it as usual (`sent`, `unknown`, `failed`); the campaign stays `cancelled` | "cancel mid-round, ack sent → counted, still cancelled" |
| A lease that expires, on any campaign | the claim and **settle** expire stale leases on every campaign in any state (campaigns `FOR NO KEY UPDATE ORDER BY id`, then rows `FOR UPDATE SKIP LOCKED`, 1000 a call) → `unknown`, `lease_token` cleared | "leased, cancelled, lease expires → settle makes it unknown" |
| A late ack after expiry | ack needs `state = 'sending' AND lease_token = $lease`; expiry cleared the token | "expire, then ack sent → row stays unknown, counters unchanged" |
| Cancel | every cancel sets `finished_at = now()`; a campaign that never started also gets `final_at = now()`; admin cancel of `sending` marks `queued` rows `cancelled` | "each state's cancel sets finished_at; no queued row after an admin cancel" |
| Purge | deletes every recipient row of a final campaign whose `finished_at` is over 90 days old, whatever the row's state | "cancelled campaign's cancelled and unknown rows purged after 90 days, counters kept" |
| A `sending` campaign with nothing left | settle: no `queued` or `sending` row → `sent`, `finished_at = now()` | "finish after the last ack and after the last expiry" |
| **The event is over while rows are still `queued`** (switch off, `MSEGAT_PROMO_SENDER` unset, a channel hold, quiet hours, or the cap not reached in time) | **settle** (which runs with the switch off): for every `sending` campaign whose event's `ends_at ≤ now()`, its `queued` rows → `skipped` (`skip_reason = 'event_over'`); once no `sending` row remains (live leases finish by ack or expiry), the campaign → `sent` with **`end_reason = 'event_over'`**, `finished_at = now()`; final at once (the event is over) | **"switch off, event ends, settle → sent with event_over, rows skipped, purged after 90 days"**; the same with a channel hold open and with no promotional sender configured |
| An `approved` campaign whose event ends before it starts | settle → `cancelled`, `end_reason = 'event_over'`, `finished_at` and `final_at` set | "switch off from approval to the event's end → cancelled event_over" |

## Migration 0073 (new file)

`SET LOCAL lock_timeout = '10s'`; `LOCK TABLE marketing_consent, marketing_state IN ACCESS EXCLUSIVE MODE` (ADD
COLUMN); `event`, `player`, `city`, `staff_user` in SHARE ROW EXCLUSIVE (foreign keys). Never `ledger_entry`,
`enrollment` (read only), `xp_entry` or `platform_setting`. Deny by default: new tables RLS enabled and forced,
`REVOKE ALL FROM PUBLIC, questify_app`, no policy; definers `SECURITY DEFINER SET search_path = public, pg_temp`; every
function `REVOKE ALL ... FROM PUBLIC` in its own statement group; only doors granted to `questify_app`. SQL codes `IV***`.

```
invitation_campaign(
  id uuid PK, organizer_id, event_id, FK (event_id, organizer_id) → event ON DELETE CASCADE,
  request_id uuid UNIQUE NOT NULL, fingerprint text NOT NULL,            -- the souvenir_replay precedent
  requested_by → staff_user SET NULL, requested_at,
  city_id → city NULL, interests text[] (≤3, catalog), history text IN (none, recent, own),
  size int 50..100000, send_after timestamptz NULL,
  state text IN (requested, approved, sending, sent, cancelled, refused),
  channels text[] NULL ⊆ {sms} in v1 (CHECK widened by T-501), cap int NULL 50..100000, send_at timestamptz NULL,
  name_ar text, name_en text,                                            -- copied at approval (Finding 1)
  admin_note text NULL (1..500), decided_by → staff_user SET NULL, decided_at,
  started_at, finished_at, final_at,
  end_reason text NULL IN (owner, admin, too_small, event_changed, event_over),
  planned, sent, unknown, failed, skipped, cancelled, opened, joined int ≥ 0 DEFAULT 0,
  published_sent, published_opened, published_joined int NULL, published_at,
  shape CHECKs: approved/sending/sent ⇒ channels, cap, send_at and at least one copied name; refused ⇒ admin_note;
  cancelled ⇒ end_reason NOT NULL; sent ⇒ end_reason IS NULL OR end_reason = 'event_over';
  requested/approved/sending/refused ⇒ end_reason IS NULL; cancelled/sent ⇒ finished_at NOT NULL)
UNIQUE (event_id) WHERE state IN ('requested','approved','sending');  INDEX (state, send_at)

invitation_recipient(
  id uuid PK, link uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),       -- the bearer token in the fragment
  campaign_id → invitation_campaign ON DELETE CASCADE, player_id → player RESTRICT,
  channel text, state text IN (queued, sending, sent, unknown, failed, skipped, cancelled),
  lease_token uuid, lease_until, error_code text (provider code only),
  skip_reason text NULL IN (opted_out, member, event_over, event_changed),
  created_at, sent_at, opened_at, joined_at, UNIQUE (campaign_id, player_id),
  CHECK ((state = 'sending') = (lease_token IS NOT NULL)))
INDEX (campaign_id) WHERE state = 'queued';  INDEX (lease_until) WHERE state = 'sending';  INDEX (player_id, sent_at)

invitation_channel_hold(channel text PK CHECK (channel IN ('push','sms','email')), hold_until timestamptz, code text)
```

**Restated:** `marketing_consent ADD language`, `marketing_state ADD language`; `marketing_state_apply` (copies it);
`set_marketing` DROP + CREATE `(channels jsonb, how text, version text, lang text DEFAULT NULL)` (MK422 `language`
unless NULL, `ar` or `en`); `marketing_audience` (plpgsql, MK403 outside system context, over `promo_pool`);
`erase_rows` (0070 body + `DELETE FROM invitation_recipient WHERE player_id = me`).

**Internal (no grant):** `promo_pool` (above), `invitation_system_only()` (`ranking_system()`, no device, READ
COMMITTED; IV403), `invitation_event_ok(event, from_claim boolean)` (returns the reason or null; `from_claim` drops the
24-hour rule), `invitation_criteria_ok(...)`, `invitation_candidates(campaign)` (the fill and estimate query:
`promo_pool('sms', city, interests)`, history, no enrollment in the event in any status, no live row for this event, the
7-day limit; ordered by `md5(campaign_id || player_id)`), `invitation_expire_leases(limit)` (the lease expiry above),
`invitation_bucket(n) → jsonb`, `invitation_audit(...)`.

**Doors (granted to `questify_app`):**

| Door | Caller | Notes |
|---|---|---|
| `invitation_request(event, body jsonb, request)` | owner (IV403 `owner_only`; another tenant's event IV404) | switch on (IV403 `feature_off`), event rule (IV409 `event_not_eligible` + reason), one open (IV409 `invitation_open`), criteria (IV422 + field); replay by `request_id`, different body IV409 `idempotency_mismatch`; audited `invitation.request` (the API checks the names first) |
| `invitation_cancel(campaign, request)` | owner | requested or approved, else IV409 `wrong_state`; Finding 2's cancel rule; audited |
| `invitation_list(event)` | owner, editor in scope | campaigns newest first (≤ 50): criteria, size, state, cap, sendAt, note, end reason, bucketed published counts and `publishedAt`; nothing exact |
| `invitation_admin_queue()` | admin (`questify_admin`, QY403) | open campaigns first, then the latest 100 closed; organizer and event names |
| `invitation_admin_get(campaign)` | admin | exact counters, the audience estimate (count of `invitation_candidates`), the event's current names, the copied names, the channel hold |
| `invitation_approve(campaign, channels, cap, send_at, note, expected_ar, expected_en, request)` | admin | requested only; event `FOR SHARE`; event rule; **IV409 `event_renamed`** unless both expected names equal the event's; names copied; channels `{sms}`; cap and send_at bounds (now − 1 min ≤ send_at ≤ event end − 1 h); audited (no counts) |
| `invitation_refuse(campaign, note, request)` / `invitation_admin_cancel(campaign, note, request)` | admin | as above; Finding 2's cancel rule |
| `invitation_start_due()` | system | switch on; `pg_try_advisory_xact_lock` or return; the oldest approved campaign with `send_at ≤ now()`: event rule (else cancelled `event_changed`), copied names only, fill up to `cap` (fewer than 50 → no rows, cancelled `too_small`), else `sending`, `planned`, `started_at`; audited without counts |
| `invitation_claim(allowed text[], size)` | system | switch on; drops SMS in the fixed band and while a hold is open; lease expiry first; sending campaigns `FOR KEY SHARE`; per-row checks (Sending) with skips; leases at most `size` (≤ 5); returns recipient id, lease token, channel, language, phone, player id, the copied names, the join code |
| `invitation_ack(recipient, lease, outcome, code)` | system | only `state = 'sending' AND lease_token = lease` (else no-op); `hold` follows Finding 2 and writes the channel hold; counters move with the state |
| `invitation_settle()` | system, **switch on or off** | lease expiry, Finding 2's event-over rules, joined pass, finish, final, daily publish, purge (5000 rows a call) |
| `invitation_open(link)` | any (public route) | first open sets `opened_at` and `opened + 1`; returns the public event card or null (unknown, purged, event over); never player data |

### Lock order (the build adds it to `docs/rules.md`, beside the other core flows)

**The invitation sender's lock order (T-409, ADR-333).** Event (`FOR SHARE`: request, approve, start) → campaigns
(`FOR UPDATE` for state changes; `FOR KEY SHARE` in the claim; `FOR NO KEY UPDATE` for counters in ack, open and settle,
which read the recipient's campaign id unlocked first; **lease expiry, in the claim and in settle, locks every affected
campaign `FOR NO KEY UPDATE ORDER BY id` before any of their rows**) → recipient rows (`FOR UPDATE`; `SKIP LOCKED` in
the claim, the lease expiry and the purge) → the channel hold row. The fill takes `pg_try_advisory_xact_lock` before
anything and skips when it is taken. No T-409 door locks a player, an enrollment, a consent row or a ledger row; erasure
deletes recipient rows under its own player lock and never touches a campaign. No outside call runs inside a transaction.

## API

| Route | Auth | Notes |
|---|---|---|
| `GET …/events/{eventId}/invitation-campaigns` | owner, editor | `{enabled, campaigns}`; counts as `{fewerThan: 10} \| {atLeast: n} \| null` |
| `POST …/events/{eventId}/invitation-campaigns` | owner, Idempotency-Key | `{cityId, interests, history, size, sendAfter}` → 201 `{campaign}`; 403 `owner_only`/`feature_off`, 404, 409 `invitation_open`/`event_not_eligible {reason}`, 422 `invalid_invitation {field}` / `event_name {language, reason}` |
| `DELETE …/invitation-campaigns/{campaignId}` | owner | → 204; 404, 409 `wrong_state` |
| `GET /v1/admin/invitation-campaigns` and `/{id}` | admin | the queue; the detail with exact counts, estimate, `availableChannels`, the hold, `names {ar, en}` with each name's rule verdict, and the rendered messages (ar, en, parts) with a placeholder token |
| `POST /v1/admin/invitation-campaigns/{id}/approve` | admin, Idempotency-Key | `{channels, cap, sendAt, note?, expectedNameAr, expectedNameEn}` → `{campaign, sendAtMoved}`; 409 `wrong_state` / **`event_renamed`**, 422 `invalid_approval {field}` / `channel_unavailable {channel}` / `event_not_eligible` / `event_name {language, reason}` |
| `POST …/{id}/refuse`, `POST …/{id}/cancel` | admin, Idempotency-Key | `{note}` |
| `POST /v1/public/invitation-open` | anonymous | `{token}` (22-char base64url of `link`) → 200 `{event}` / 404 `invitation_ended` / 400 malformed; its own bucket `BUCKETS.invitationOpen`, 120 an hour per address, counted before the token is read |

All `no-store`. Every new code gets Arabic and English messages (`http-errors.ts`, `messages.ts`); Western digits.

## Tests

- **DB (`test/db/invitation-campaigns.int.test.ts`):** every named test in § Finding 1 and § Finding 2, plus: request
  (owner only; editor, limited editor and another organizer refused; every event-rule reason including unlisted and
  private; criteria bounds; one open; replay and mismatch; switch off); approve, refuse, cancel (states, bounds, admin
  only); fill (opted out, minor, banned, deleted, no phone, each criterion, `recent`/`own`, enrolled in any status, a
  live row for this event, the 7-day limit by state and `sent_at`, the cap and its per-campaign order, `too_small`,
  `event_changed`, a second server's fill skipped while the lock is held, a rename after approval does not cancel);
  claim (system only from player, staff, admin and device contexts; skips for `opted_out`, `member`, `event_over` and
  `event_changed` for each of unlisted, private, guest-list-only, a domain lock and link joining off; SMS refused at
  22:00 and 08:59 Riyadh and allowed at 09:00 even when the API passes it; a 21:59:30 claim refused by the 60 s margin;
  refused during a hold; at most 5; two claimers disjoint; switch off claims nothing); ack (each outcome; the hold writes
  one channel hold and requeues without a count); open (once, unknown, purged, event over, no player field); settle
  (joined only after `sent_at` and not pending, once; finish; final; daily publish; runs with the switch off); erasure
  (rows gone, counters kept); language recorded, copied, NULL read as Arabic, a 3-argument `set_marketing` call still
  works; restated `marketing_audience` refused outside system context. **Organizer answers never carry an exact count**
  (a property test over random counters: every number is null or a multiple of 10 ≥ 10); no organizer-readable audit row
  has a count.
- **Security:** outsider (every new function no PUBLIC; the exact `questify_app` grant list; no table rights on the three
  tables; `promo_pool` not executable by the API role), cross-tenant (entries for the three tables; organizer B and a
  limited editor see 404 for A's campaign), routes inventory, `test/db/marketing.int` updated.
- **Timing (by hand, recorded in ADR-333):** fill and estimate at 100,000 opted-in players; gate 2 s for the fill (the
  API's statement limit is 5 s, `pool-options.ts`).
- **Unit:** the name rule (§ Finding 1), message (both languages, the copied name, fallback name, `trimName`, both links
  in every message, **≤ 3 parts** for 40-unit Arabic and Latin names, the preview's placeholder token), sender outcome
  mapping (number vs account codes), `invitationSmsAllowed`/`invitationSmsTime` (22:00, 08:59, 09:00, a Ramadan day's
  22:00–12:00, the edge days), tick (rounds of 5, budget, **after an account refusal no further round is claimed**, the
  quiet window with the margin, switch off, stop), config (refuses `MSEGAT_PROMO_SENDER` equal to `MSEGAT_SENDER`),
  routes (shapes, refusals, idempotency, `event_renamed`, the open bucket), schemas. **App:** a guard test that no
  `apps/app` file names the `invitation-campaigns` routes (FR-740; the `event-isolation.test` precedent).
- Full `npx vitest run` once with both URLs before reporting.

## T-409b (standard, web)

Dashboard: Invitations per event (shown when the switch is on): list with state and counts ("120+", "Fewer than 10",
"Updated daily"), the request form (city, up to 3 interests, history, size, earliest send), the name rule's message when
an event name cannot be sent, owner-only actions with the owner note (update the count in `e2e/organizers.spec.ts`), the
"nothing is charged here" and "you see only rounded counts, never who" lines. Console: queue, detail with estimate, the
event's names and their verdicts, the full rendered messages next to Approve (which sends the names it showed), the
`event_renamed` refresh prompt, hold banner, approve (SMS only; the moved time shown), refuse, cancel. Landing page
`/[lang]/i`: token from the fragment, cleared, POST, event card, "Open in Questify" (join link), "This invitation has
ended". Every string in both languages through ux-araby; RTL; phone width. Browser specs for the three surfaces.

## Docs the build updates

API.md, DATA_MODEL.md (three tables; `invitation_recipient` is personal data, 90-day retention), SECURITY.md (a T-409
boundary section), `docs/rules.md` (the lock order above), SRS (FR-738 to FR-740 status, FR-740 clarification),
CONFIGURABILITY.md (the switch; 50, 10, 7 days, 30 days, 90 days, rounds of 5 are code constants until T-703's tuning),
RUNBOOK (the T-409 section written with this plan: fill in the measured timing), STORE_COMPLIANCE (PD-22 holds; the
T-807 privacy line), `stryker.config.json` (the globs below).

## Mutation globs (core, GitHub only; the build adds them to `stryker.config.json`)

`apps/api/src/invitation-campaigns/**/*.ts`, `packages/shared/src/invitation-campaigns/**/*.ts`,
`apps/api/src/marketing/marketing.ts`, `apps/api/src/marketing/routes.ts`, `!**/*.test.ts`.

## Risks for the code review

1. Joins after a send, read with the member list's `joinedAt`, hint at who was invited (stated, not solved: ADR-332).
2. The name rule is a filter; spelled-out addresses and numbers rely on the admin reading the exact text.
3. At most once: a crash after Msegat accepts counts the message as `unknown`, never resent.
4. Restating T-407's `set_marketing` (defaulted fourth argument) and `marketing_audience` (system only).
5. An opt-out or erasure racing a claim: a message can still leave within seconds (inside FR-1738's 24 h).
6. The hot campaign row: every ack and open updates its counters.
