# T-210 — Event activation and limits

Delivers FR-1019, FR-1020, FR-1021, FR-1729, FR-1737 and the activation half of FR-1402 (ADR-076). **Max bar:** it adds
the first admin powers (activation, limits, add-ons) and a wall on joining. Migration **0027** (0026 and 0028 are being
built in parallel: T-204/T-205 and T-212).

## Scope

- **In:** the owner's Request activation and Withdraw (an editor sees the line, not the button); the console's queue,
  activate (limit mode and number, add-ons), reject with a note, change the limit after activation, unlock and lock
  add-ons (the existing settings service, now reachable); the hard limit refusing joins at the database, soft and hard
  alerts at 80% and 100% shown on the dashboard; the dashboard's activation card and banners; a minimal console (queue,
  event page, look up an event by join code); the app's "This event is full." message.
- **Already true, kept and tested:** a draft has no working join link, event page or quests (`join_event`,
  `public_event`, `public_event_quests` skip drafts, migration 0018). FR-1729's hiding is `composeConfig` (T-007): a
  gated feature is off unless unlocked; the dashboard shows no switch for a gated feature that is not unlocked.
- **Out (Q-110, Q-111):** organizer suspension (FR-1607, the suspend half of FR-1402) → T-701: it narrows every player
  read path and `join_event`, which T-212 rewrites in parallel. Usage figures (FR-1730) and editable support contact
  (FR-1731) → T-703 with the other platform settings; no SMS, push or storage metering exists yet. Emails to the owner
  on activation, rejection and 80/100% (FR-1727's alert switches) → the notifications task; the dashboard banner is
  the alert for now. Rehearsal (FR-1737's exception) → T-211.

## Data (migration 0027)

1. `event` gains `player_limit_mode` (`none` | `soft` | `hard`, default `none`), `player_limit` (1 to 1,000,000; NULL
   exactly when the mode is `none`), `activated_at`, `activated_by`. Not in the API role's INSERT or UPDATE grants:
   only definers write them.
2. `event_activation_request` (one row per event: `pending` or `rejected` with a note ≤ 500): read by the event's
   team within their event limit and by admins; **no write grant** — definers only. History lives in the audit log.
3. `event_limit_alert` (`event_id`, `level` 80 | 100, `players`, `reached_at`; one row per level): read like the
   request; no write grant; written by the limit trigger and the limit definer.
4. **Seats** (ADR-141): enrollments `pending`, `active` or `banned`. A player who left or was removed frees a seat.
5. **Trigger `enrollment_player_limit`** (BEFORE INSERT OR UPDATE OF status on `enrollment`, definer): only a move
   into a seat counts (an insert that will conflict with the player's existing row is let through to `ON CONFLICT`).
   Mode `none`: nothing. `hard`: a transaction advisory lock on the event serializes seat-taking, then the count; at
   the limit it raises `QL409`, so `join_event` (and T-212's `join_invited`) abort whole. Both modes record the 80%
   and 100% alerts once (`ON CONFLICT DO NOTHING`).
6. **Definers** (each `REVOKE … FROM PUBLIC`, `GRANT … TO questify_app`, audit in the same transaction):
   - `request_event_activation(event, request)` — the owner of the event's organizer (`QE403`); a draft only
     (`QE409`); a pending request is left as it is (no second audit); a rejected one becomes pending again.
   - `withdraw_event_activation(event, request)` — the owner; removes a pending request; false when there was none.
   - `activate_event(event, mode, limit, addons[], request)` — an admin (`QE403`); a draft only (`QA409`); start and
     end set and the end in the future, and a physical event has a venue (`QA422`, detail `times` / `venue`); sets
     `scheduled` (the tick and `event_status_now` make it live when its start has passed), the limit, replaces the
     add-ons with exactly the list, removes the request, clears alerts; audit `event.activate`.
   - `reject_event_activation(event, note, request)` — an admin; a pending request only (`QA409`); audit.
   - `set_event_player_limit(event, mode, limit, request)` — an admin; an activated, not archived event (`QA409`);
     recomputes the alerts from the current seats; audit `event.limit`.

## API

- New access kind **`admin`**, only under `/v1/admin/`, whose hook runs no-store, Origin and session checks, then
  refuses anyone whose account is not an active platform admin with **404** (the console's routes are not
  advertised). Admin work runs with `isAdmin` and the admin's id in the database context.
- Owner side (organizer scope): `GET …/events/{id}/activation` (member) → `{state: not_requested | requested |
  rejected | activated, requestedAt, note, limit: {mode, value}, players, alerts, addons}`; `POST` (owner) → 201
  `{requestedAt}` (200 when already requested); `DELETE` (owner) → 204 / 404.
- Console: `GET /v1/admin/activation-requests`; `GET /v1/admin/events?code=`; `GET /v1/admin/events/{id}`;
  `POST /v1/admin/events/{id}/activate` (Idempotency-Key) `{limit: {mode, value?}, addons}`; `POST …/reject {note}`;
  `PUT …/limit {mode, value?}`; `PUT|DELETE …/addons/{feature}`. Add-ons are checked against the registry's gated
  features (422 `unknown_addon`).
- Join: `QL409` → 409 `event_full` ("This event is full."), in both languages.
- Core module for mutation testing: `src/activation/activation.ts` (input rules, refusal mapping, the view).

## Dashboard, console, app

- Event page: an activation card. Draft: "Not activated yet…" with Request activation (owner) or "Ask the owner to
  request activation" (editor); requested: date and Withdraw (with a confirmation); rejected: the note and Request
  again; activated: the limit line and the add-ons. Banners at 80% and 100% (hard: "Joining is closed", soft:
  "Joining stays open"). Nothing about prices (FR-1020): "Price and payment are arranged outside Questify."
- Console (`/[lang]/console`): the queue, an event page with the activate form (mode, number, add-on checkboxes),
  reject with a note, change limit, add-on toggles, and a lookup by join code. A non-admin gets the 404 page.
- App: the join error `event_full`.

## Plan review (CTO, 86 → about 93 with the fixes)

Folded in: only a move into pending or active takes a seat, so a ban at a full event is never refused (MAJOR 1);
ADR-140 to ADR-142 and Q-110/Q-111 recorded, and the T-701/T-703 lines carry the moved FRs (MAJOR 2); `isEventFull` is
exported for every enrollment writer, and T-212 was told (MAJOR 3); the limit definer takes the same seat lock and a
lower limit keeps everyone (4); request, withdraw and activate lock the event row (5); activation clears the settings
cache (`settings.forget`) (6); definers re-read the admin account (`app_admin_id`) (7); 80% is `ceil(0.8 × limit)` (8);
the lock uses the two-key form with namespace 270027 (9).

## Tests

- Database (`test/db/activation.int.test.ts`): every definer's seat rules and refusals, audit rows, hard limit at the
  boundary with concurrent joins, soft never blocks, alerts once per level, seats rule, conflict insert passes.
- Security: cross-tenant probes for both new tables; the outsider catalog suite covers the new objects; route
  inventory: every `/v1/admin/` route refuses a signed-in non-admin (404) and anonymous (401).
- API integration for the routes; unit tests for `activation.ts`; web unit tests for the console and card helpers.
