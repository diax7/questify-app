# T-407 — Marketing consent per channel and opt-out; interests, city and the "For you" list

Delivers FR-733, FR-734, FR-735, FR-736, FR-737, FR-1111, FR-1112 (the rule, enforced at the audience door; the sender
itself is T-706), FR-1113, FR-1114, FR-1738. Depends on T-107 (sign-in), T-403 (`city`). Never push, deploy, run EAS or
run local mutation testing. Choices are **Proposed ADR-316 to ADR-319 / Q-285 to Q-289**.

**Bar: STANDARD.** Consent and preferences are personal data (PDPL), but they touch none of the core areas: no sign-in
function is changed (the consent step is an app screen after sign-up), no ledger, no tenant isolation rule, no lock
shared with a payer. The one core-adjacent item, the "set your interests" Questify quest metric (FR-710, a new
`player_metrics` metric counted by `questify_sync`, which pays XP), is **carved out as T-407c** (core, small; ADR-319).

## Split (ADR-316, Q-285)

| Part | Delivers | Migration |
|---|---|---|
| **T-407** | Migration 0070, shared schemas, API doors, the send window and audience door, the event interests field and the opt-out page on the web | 0070 |
| **T-407b** | App: the consent step, Settings → Notifications, interests and city, the "For you" list; every string | none |
| **T-407c** | CORE: the `interests_set` metric for the Questify quest "set your interests" | later |

The T-405/T-406 precedent (server, then screens). T-407 is checked when its API, DB and security suites pass.

## Data (migration 0070)

Deny by default: every new table has RLS enabled and forced, `REVOKE ALL FROM PUBLIC, questify_app`, no policy, no
grant; only definers (`SET search_path = public, pg_temp`, PUBLIC EXECUTE revoked in the same group) read or write
them. Definers that touch one player lock the player row first (`FOR NO KEY UPDATE`, the same order as `erase_player`).

| Object | Shape |
|---|---|
| `interest` | `id text PK` (`^[a-z][a-z0-9-]{1,29}$`), `name_ar`, `name_en`, `position`. Seeded, 12 rows (sport, music, tech, gaming, food, art, culture, learning, business, family, wellness, travel). Read through `interest_list()`; console editing with T-703/T-709 like `city` |
| `player_preference` | `player_id PK → player`, `city_id → city` (nullable), `interests text[]` (at most 8, catalog ids, catalog order), `updated_at`. Written by `set_preferences`, read by `own_preferences`. Never in a public profile (FR-733) |
| `event.interests` | `text[] NOT NULL DEFAULT '{}'`, at most 3, validated by a trigger against `interest`; the event team sets it through the existing column grant (the `city_id` precedent) |
| `marketing_consent` | Append-only log: `id`, `player_id → player`, `channel` (`push`, `sms`, `email`), `granted`, `method` (`signup`, `settings`, `opt_out_link`), `text_version` (required when granted), `created_at`. UPDATE, DELETE and TRUNCATE refused; erasure deletes under `app.erasure` (the `player_acceptance` precedent) |
| `marketing_state` | `(player_id, channel)` PK, `opted_in`, `changed_at`. Written only by an AFTER INSERT trigger on the log, so state and log cannot disagree. Partial index on `(channel, player_id) WHERE opted_in` |

Doors (all granted to `questify_app` only):

- `own_marketing()` → `{channels: {push|sms|email: {optedIn, changedAt}}, asked, canOptIn}`; `asked` is true once any
  state row exists; `canOptIn` is the age rule below.
- `set_marketing(channels jsonb, how text, version text)`: validates every key and value first (MK422), then records
  one log row per channel whose state changes **or has no state yet** (the first answer is recorded even when it is
  "off": the skipped step is three dated opt-outs, FR-735). A turn-on by a player who may lack legal capacity is
  refused (MK403 `age`). Turning off is never refused.
- `marketing_opt_out(who uuid, ch text)`: for the signed link; same lock, method `opt_out_link`, no-op when already
  off; works for active and banned players, answers `opted_out`, `already_off` or `gone`.
- `marketing_audience(ch, city, any_of, after, page)`: the recipients of a promotion on one channel: active players
  opted in on `ch`, optionally in a city or with any of the interests, keyset by player id, at most 1000 a page.
  **The only door a promotional sender may use to choose recipients** (FR-737, FR-1111). Returns ids only.
- `marketing_consent_history(target uuid)`: platform admins only (`questify_admin`), the player's log newest first, one
  audit row per read (`marketing.consent_read`; FR-1113, SECURITY threat 5).
- `set_preferences(city text, wanted text[])` / `own_preferences()`; `interest_list()`.
- `own_for_you(page)`: the caller's recommended events (below).
- `erase_rows` is restated (the 0064 body plus the new deletes): preference, state and log rows go with the account.

### Age (ADR-317, Q-286 For Dhia / counsel)

PDPL IR Art. 11 asks consent from a person with full legal capacity and `STORE_COMPLIANCE.md` §3.1 leaves the age
"to check with counsel". Build-around: `canOptIn` is true only when the Riyadh year minus the birth year is at least 19
(a birth year alone proves 18 only from 19), so a possible minor is never offered or accepted for a marketing channel.
No guardian flow is built. The constant is one number in `marketing_adult`; counsel's answer changes that line.

## "For you" (FR-734, ADR-319)

Candidates are the events the public list shows (`access = 'public'`, `'public_list'` in `join_methods`, scheduled or
live now) that the caller has no enrollment in. An event matches when it shares an interest with the caller or lies in
the caller's city. Order: both, then interest only, then city only; inside a group, by interest overlap, then soonest
start, then id. At most 20; no cursor. A caller with no interests and no city gets an empty list. Private, unlisted
and workplace-hidden events cannot appear (same predicate as `public_events`). The answer is the public event card
(id, join code, bilingual name and venue, kind, timezone, times, status) plus the interest ids and the city, no counts.

## The promotion gate (FR-737, FR-1738, ADR-318)

- Audience: `marketing_audience` (above); the API wrapper `readPromoAudience`.
- Window: `promoSendTime(channel, at)` in `apps/api/src/marketing/send-window.ts`. SMS is never sent 22:00–09:00 Saudi
  time, and in Ramadan never 01:00–12:00; a time inside the window moves to the window's end. The Ramadan day comes
  from the Umm al-Qura calendar (`Intl`); within one day of Ramadan's edges the calendar can differ from the sighting,
  so on those days both windows apply (22:00–12:00). Push and email have no window (ADR-065 declined quiet hours);
  whether they should hold the SMS window is **Q-287, For Dhia**, one constant to change.
- Opt-out: effective at once (the state flips in the transaction), well inside FR-1738's 24 hours; a sender reads the
  audience at send time.
- Opt-out link (FR-1114): `optOutLink(playerId, channel)` builds `https://<join host>/<lang>/opt-out?t=<token>`; the
  token is `base64url(player uuid bytes ‖ channel byte ‖ HMAC-SHA256 truncated to 16 bytes)` keyed from `AUTH_SECRET`
  (purpose `marketing-opt-out`), no expiry (a link must keep working), verified in constant time. `POST
  /v1/public/marketing/opt-out {token}` always answers 204 for a well-formed token and 400 for a malformed or forged
  one, never saying whether the player exists. The web page `/[lang]/opt-out` posts it. Senders (T-501, T-706, T-409)
  put the link in every promotional message and the SMS text states the sender "Questify-AD" (FR-1112 is the sender
  registration, Q-034; nothing here sends).

## API (all `no-store`; player routes bearer-only)

| Route | Notes |
|---|---|
| `GET /v1/interests` | public, cached 1 h, like `/v1/cities` |
| `GET /v1/me/preferences`, `PUT /v1/me/preferences` `{cityId \| null, interests[]}` | replace; 422 `invalid_preferences {field}`; 60 writes an hour per player |
| `GET /v1/me/marketing`, `PUT /v1/me/marketing` `{textVersion, method, channels}` | 409 `consent_text_outdated` when `textVersion` is not the current one; 403 `consent_age`; 60 writes an hour |
| `GET /v1/me/for-you` | the list above |
| `POST /v1/public/marketing/opt-out` | the token; throttled per address |
| `GET /v1/admin/players/:playerId/marketing-consent` | platform admins, audited |
| `GET /v1/me` | gains `marketing: {asked, canOptIn}` for the app's one-time step |
| `POST/PATCH /v1/organizers/.../events` | gain `interests` (at most 3 catalog ids; 422 `invalid_event {field: interests}`) |

The consent text version is the shared constant `MARKETING_TEXT_VERSION` ("1"); the text itself (per channel, sender
named, how to opt out, unticked, not bundled with the privacy policy) is in `messages.ts` and is **Q-288, For Dhia /
counsel** to approve (Arabic first). Counsel also answers Q-289: whether consent proof must outlive the account (built:
it is erased with the account).

## Surfaces

- **Web (T-407):** the event form gets an Interests picker (chips, at most 3) beside the city; the `/[lang]/opt-out` page.
- **App (T-407b):** a one-time step after the first sign-up (all three channels unticked, "Skip" records the opt-outs),
  Settings → Notifications (three switches, each change saved at once), Profile → interests and city, the "For you"
  list until T-408 puts it in Explore.

## Store compliance gate

Apple 4.5.4 (promotional push needs explicit opt-in language in the app plus an in-app opt-out; push is never
required), Apple 5.1.1 (consent not forced; withdrawal easy), Play User Data, PDPL Art. 25 and IR Art. 11/12/29 (per
purpose, as easy to withdraw as to give, recorded with time and method), CST 4.6.6 (separate sender, window, 24 h
stop). Privacy labels: interests and city are already declared (DATA_MODEL). No new SDK, permission or dependency.

## Tests

DB (`test/db/marketing.int.test.ts`): defaults off; first answer recorded even when off; change-only logging; turn-on
refused for a possible minor and allowed at 19+; append-only log (UPDATE, DELETE, TRUNCATE refused; erasure deletes);
state follows the log; opt-out link door (active, banned, deleted, already off); audience (opted-in only, per channel,
city, interests, deleted and banned left out, paging); a concurrent on/off pair ends consistent; preferences (unknown
city, unknown or repeated interest, nine interests, clearing); event interests (trigger, four refused); For you
(interest, city, both, private and unlisted left out, joined events left out, ended left out, order). Outsider and
cross-tenant lists updated; routes inventory entries. Unit: send window (22:00, 08:59, 09:00, Ramadan edges, day
boundary, DST-free Riyadh), token round trip and forgery, schemas. Route tests: refusals and shapes. Web: the form's
interests, the opt-out page. Mutation target (core only): none; T-407c carries the core files.
