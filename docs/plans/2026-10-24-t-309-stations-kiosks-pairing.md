# T-309 — Rotating screen QR, station pages, kiosks and device pairing

F-106, F-107, F-238: a quest's QR shown on a screen and changing every 30 seconds, on an operator's phone or on a
**station page** opened on any tablet or TV (FR-314); a tablet working as an unattended **kiosk** that scans players
(FR-315); and **pairing**: station pages, kiosks and big screens show nothing until paired from staff mode or the
dashboard, and any pairing can be revoked (FR-1713). **Core bar**: a screen code is a signed proof and a paired device
is a new kind of credential (rules.md, Quality bar), so this plan gets one Opus plan review, one Opus code review,
mutation on GitHub. Migration **0057** (new file; 0048 to 0056 are undeployed but 0055 and 0056 are under review, so
their functions are changed here by restating them, never by editing them). Depends on T-205 (operators, abilities,
station scan), T-105/T-104 (the completion door, signed codes), T-211 (the go-live wipe), T-308 (the latest
`record_completion`), all done.

Open choices are my recommendation, written as **Proposed** ADR-238 to ADR-242 and Q-201 to Q-204, entered in
`docs/DECISIONS.md` and `docs/OPEN_QUESTIONS.md` with this plan.

**CTO plan review 2026-10-24: 84/100, findings folded in** (MAJOR 1: who paired is nullable, so removing an operator or
team member revokes and never fails; MAJOR 2: the secret is replaced once the device is paired; MAJOR 3: a device paired
by an operator works only while that operator still could; MAJOR 4: one venue address cannot starve pairing, and a
reload never unpairs; minors 5 to 11 and the notes). Each is marked "(CTO n)" below.

## Split (ADR-238)

Three pieces, each core: the device credential, a rotating proof, and a door that pays a player with no staff present.
One worker cannot build and test all three well, and the kiosk needs both of the others.

- **T-309 (this build)**: pairing for all three kinds (station, kiosk, big screen), the device credential, revocation,
  the Devices panel and staff-mode pairing; the rotating screen QR on the operator's phone and on the station page; the
  big-screen page up to "paired" (its scenes are T-504's). Delivers FR-314 and FR-1713.
- **T-309b (split)**: the kiosk: the player's **live code** (purpose 0x08), the kiosk page with its camera, the kiosk
  door. Delivers FR-315. Migration 0058. Its design is fixed in the "Kiosk" section below; its worker writes its own
  plan from it, as T-306b did. Depends on T-309.

## What exists that this plan builds on

- **Signed codes** (`apps/api/src/quests/qr.ts`): one format byte per purpose (0x01 quest, 0x02 My QR, 0x03 operator
  invite, 0x04 passport step, 0x05 hidden category, 0x06 NFC tag), a 16-byte id, a 4-byte version, HMAC-SHA256 cut to
  16 bytes, each purpose its own key derived from `QR_SECRET`, strict canonical base64url (50 characters). The comment
  there already says "A rotating code (FR-314) gets its own".
- **My QR is fixed** (ADR-137, Accepted): the player's id and a version, shown offline for as long as the player
  likes. That is why FR-315's "expired My QR screenshot" cannot be met by scanning My QR at an unattended kiosk (see
  Kiosk).
- **Abilities** (`staff_assignment.abilities`, 0026): `show_rotating_qr` and `scan_quests` already exist, on by
  default (FR-908); the quest limit `staff_assignment_quest` (FR-909); `nfc_writer` (0056:245) is the model of an
  operator check. The Tools tab lists "Rotating QR" (FR-922).
- **The completion door** `record_completion` (latest 0056:106): reserved key prefixes, quest read,
  `ensure_rehearsal_wiped` first, enrollment `FOR NO KEY UPDATE`, the quest re-read after the wipe, replay, then
  `quest_open_check`, the method check, the operator's 10-second rule, caps under the enrollment lock, the boost.
  `complete_quest` (0048:346) is the player's granted door.
- **Credentials**: staff sessions are a 32-byte random token in an HttpOnly `__Host-` cookie, stored as its SHA-256
  and found through `withPreIdentityContext` (one lookup kind per token type); player sessions are bearer tokens
  (`players/guard.ts`). Every route declares its access kind (`route-access.ts`, whose comment already expects a
  "screen token" kind with its own hook).
- **Web**: the dashboard's `/v1` forwarder (one origin, cookies, the `Origin` check on writes), the page CSP with a
  nonce and `Permissions-Policy: camera=()` (`apps/web/src/lib/security-headers.ts`), `uqr` draws QR codes (ADR-115),
  `/[lang]/q/[token]` and `/[lang]/t/[token]` landing pages.

## Pairing (T-309; ADR-239)

### The flow (a device shows a code, staff claim it)

The device never types anything and its credential is never shown: the TV-sign-in pattern.

1. An unpaired browser opens `/{lang}/station`, `/{lang}/kiosk` or `/{lang}/screen` (one page per kind, no ids in the
   URL, nothing in it worth sharing). The page first calls `GET /v1/device`; only on a 401 does it call `POST
   /v1/device/pairing` (public, `Origin` checked, CTO 10), so a reload never unpairs or re-requests (CTO 4). A POST
   that arrives with a valid device cookie answers that device's current state (pending or paired) and makes nothing
   (CTO 4). Otherwise the API makes a **device
   secret** (32 random bytes, `generateToken()`) and a **pairing code** (8 characters from a 31-letter alphabet without
   0, O, 1, I, L; about 40 bits), stores only their hashes (the secret's SHA-256; the code's HMAC with a key derived
   from `AUTH_SECRET`, `pairingCodeKey`), and answers the code, its expiry (10 minutes) and the kind asked for. The
   secret goes back only as the cookie `__Host-qs_device` (HttpOnly, Secure, SameSite=Strict, Path=/, 400 days): page
   scripts never read it, it is never in a URL, a log, an audit row or an error.
2. The page shows the code as text (`ABCD-EFGH`) and as a QR of `{origin}/{lang}/pair#ABCDEFGH` (the fragment never
   reaches a server log, as the operator invite), the kind ("Station", "Kiosk", "Big screen") and "Waiting to be
   paired". It shows **nothing of any event**. It polls `GET /v1/device` every 3 seconds (5 after a 429); at the expiry
   it asks for a fresh code under the same cookie (the request row's code is replaced, the secret kept).
3. **Staff claim the code**:
   - *Staff mode* (app, Tools → "Pair a device"): the operator scans the page's QR (the app accepts only a `/pair#`
     URL of the configured origin) or types the code, picks what the device becomes and, for a station or kiosk, the
     quest (only quests in their quest limit with the matching method on), and a label (1 to 40 characters, e.g.
     "Hall B TV"). A station needs `show_rotating_qr`; a kiosk needs `scan_quests` (it scans as the operator would).
     **Big screens are paired from the dashboard only** (they show the whole event, not one quest).
   - *Dashboard* (owners and editors; viewers read): the event's **Devices** page, "Pair a device": type the code, the
     same choices, any kind.
   - Before confirming, both show what the device told the API ("Chrome on Android", from its User-Agent reduced to a
     browser and system name, kept only on the request row and the device row) so staff can tell it is the screen in
     front of them; the paired page then shows its label in a corner so staff can check it.
4. `claim_device(...)` (definer) checks the request's `expires_at` (an expired code is `DV404`, as an unknown one),
   turns the request into a **paired device** row and deletes the request in one transaction. The device's next poll
   answers `{state: "paired", activated: false}` and **nothing of the event**.
5. **The secret is replaced once paired (CTO 2)**: the page then calls `POST /v1/device/activate` (device, `Origin`
   checked), which makes a new secret, stores its hash, keeps the old hash as `previous_hash` and answers it as a new
   `Set-Cookie` in the same transaction. The old secret stays valid only until the new one is first used or 60
   seconds pass, whichever comes first (so a lost answer does not strand the screen), then answers `device_unpaired`.
   Only an activated device gets its event, quest and codes. A secret seen by anyone before pairing (it was in the
   browser during the wait) is thus worthless after it. Tests: old secret after the new one is used, and after 60
   seconds, both `device_unpaired`; a `renew` keeps the same secret (CTO 11).
6. The code's hash is unique; a collision when making one is retried (up to 3 times, then `DV503 busy`).

### Data (migration 0057)

- `device_request (id uuid PK, secret_hash bytea UNIQUE, code_hash bytea UNIQUE, kind station|kiosk|screen,
  client text 0..60, expires_at, created_at)`: no tenant columns (it belongs to no one yet). RLS forced, PUBLIC
  revoked, no grant; written only by `open_device_request` and `claim_device`. `open_device_request` deletes up to 100
  rows expired more than a day ago on each call, and refuses (`DV503 busy`) when 5,000 unexpired requests exist (a
  flood cannot fill the table). Reaching the cap writes an ops alert (the log line `device.request_flood`, which the
  error tracker alerts on, as the other platform alarms) and SECURITY.md records the risk: a flood can delay new
  pairings for up to 10 minutes, never touch paired devices (CTO 9).
- `paired_device (id uuid PK, organizer_id, event_id, kind station|kiosk|screen, quest_id uuid NULL, label text 1..40,
  client text 0..60, secret_hash bytea UNIQUE, previous_hash bytea NULL, previous_until timestamptz NULL, activated_at,
  status active|revoked, paired_by_operator uuid → staff_assignment ON DELETE SET NULL, paired_by_staff uuid →
  staff_user ON DELETE SET NULL, paired_at, revoked_at, last_seen_at)`. CHECKs: `(kind = 'screen') = (quest_id IS
  NULL)`; `num_nonnulls(paired_by_operator, paired_by_staff) <= 1 AND (status = 'revoked' OR
  num_nonnulls(paired_by_operator, paired_by_staff) = 1)` (CTO 1: an active device always names who paired it; a
  revoked one may have lost it, and the `device.pair` audit row keeps who it was); `revoked_at` set iff revoked. `(quest_id,
  event_id)` → `quest (id, event_id)` ON DELETE CASCADE (a device is setup, not evidence); `(event_id, organizer_id)` →
  `event` ON DELETE CASCADE. At most 200 active devices an event (`DV409 limit_reached`). RLS forced, PUBLIC revoked,
  no grant. Kept by the rehearsal wipe (setup, as NFC tags).
- **Operator removal revokes what they paired** (FR-905, "at once"): a `BEFORE DELETE` trigger on `staff_assignment`
  revokes that assignment's active devices (audited `device.revoke`, reason `operator_removed`) before the FK sets
  `paired_by_operator` NULL; the CHECK then holds because the rows are already revoked, so the operator's delete
  (0026:675) never fails (CTO 1, tested). The dashboard's remove dialog says "Devices they paired stop working".
- **Team-member removal likewise (CTO 1)**: removing a member from the organizer (the membership delete) revokes the
  devices that staff user paired in that organizer's events (reason `member_removed`), by the same kind of trigger; a
  deleted staff user's rows are revoked first by a `BEFORE DELETE` trigger on `staff_user`, then the FK sets NULL.
  Tested both.
- `quest.verification` gains `screen_qr`; `quest_verification_known` widened: `screen_qr` on `scan_qr` only, and
  **never with `quest_qr`** (`NOT ('screen_qr' = ANY (v) AND 'quest_qr' = ANY (v))`): a printed code beside a rotating
  one would undo the rotation. Since T-308 requires `quest_qr` with `nfc`, NFC and the screen QR are not combined (Q-203
  asks). `quest_completion_method_check` gains `screen_qr`. Shared registry (`packages/shared/src/quests/registry.ts`):
  `scan_qr.verifications` gains `screen_qr`; the builder refuses the pair (`422 invalid_quest {field:
  verification}`), the table is the second wall.

### How a paired device authenticates

- New access kind **`device`** in `route-access.ts`, allowed only where `url === "/v1/device" ||
  url.startsWith("/v1/device/")` (CTO 5), enforced by its own hook (`apps/api/src/devices/guard.ts`) that runs on each
  route's `config.access === "device"`, never on the path: reads `__Host-qs_device` (43 characters, else 401), finds
  the device through a new pre-identity lookup kind `device` (`app.device_token_hash`, opening exactly one
  `paired_device` or `device_request` row), and sets `request.device` as a union `{state: "pending", requestId, kind} |
  {state: "paired", id, kind, eventId, questId, activated}` (CTO 5) and the idempotency principal `device:{id}`. Only
  `GET /v1/device`, `renew` and `activate` take a pending or unactivated device; every other device route needs
  `paired` and activated. A revoked,
  unknown or ended device answers **401 `device_unpaired`**, and the page drops everything it showed and starts over at
  step 1. `Cache-Control: no-store` on every device answer. Writes need `Origin` equal to the dashboard origin (the
  staff routes' CSRF rule).
- `withRequestContext` gains `deviceId` (`app.device_id`, `app_device_id()`); device definers require it and read
  their device row themselves, so a forged setting without a row opens nothing.
- `last_seen_at` is written at most once a minute (as staff sessions).
- **A device stops working** when revoked (the next request, within 3 seconds for a polling page), when its event is
  deleted (cascade), when its quest is deleted (cascade), when its operator is removed, and when its event has ended
  more than 24 hours ago (answered `device_unpaired`, so a forgotten TV goes blank by itself). A device idle 30 days is
  treated as revoked (the guard checks `last_seen_at`).
- **Threats and answers** (SECURITY.md gains these rows): a shared station link opens a blank pairing page (the URL holds
  nothing; FR-1713's WhatsApp case); a photographed pairing code is useless without the cookie that only the showing
  browser holds; a stranger who gets staff to pair *their* remote browser (social engineering through the dashboard's
  type-in) gets a station whose codes still expire within 45 seconds and whose label, client and last-seen sit on the
  Devices page with Revoke; a stolen cookie works until Revoke, the event's end + 24 h, or 30 idle days (and one seen
  before pairing is dead after activation, CTO 2); guessing a code needs a staff account of an event, 10 claims a
  minute per staff member, and unknown-code claims are throttled at 30 an hour per event and per organizer, with a
  platform counter that alerts ops above 200 an hour (CTO 8), against 40 bits that live 10 minutes.
- **A device paired by an operator works only while that operator could still pair it (CTO 3)**: when
  `paired_by_operator` is set, `screen_code_for_device` (and T-309b's kiosk door) re-reads that assignment's current
  abilities and quest limit: `show_rotating_qr` for a station, `scan_quests` for a kiosk, the quest still within the
  limit. If not, the device answers the state `paused` ("Paused by the event team") and no code; it resumes if the
  ability or quest comes back. Tests: ability turned off, quest taken out of the limit, each for a station and (T-309b)
  a kiosk.

### Revocation and the Devices page

- Dashboard **Devices** page (owners and editors act; viewers read): kind, label, quest, client, paired by, when, last
  seen, status; **Revoke** (`revoke_device`), **Revoke all big screens** (ADR-241), **Revoke all**. Audited
  `device.pair` / `device.revoke` (who, kind, label, quest; never a secret or code).
- Staff mode: Tools → "My paired devices": the operator's own, each with Revoke (an operator revokes only what they
  paired).
- A station or kiosk whose quest loses its method stays paired but shows "This quest no longer uses this screen" and no
  code; it resumes if the method comes back.

### Who may pair

| Kind | Staff mode (operator) | Dashboard |
|---|---|---|
| Station | `show_rotating_qr`, the quest within their limit, `screen_qr` on | owner, editor |
| Kiosk (T-309b) | `scan_quests`, the quest within their limit, `kiosk` on | owner, editor |
| Big screen | no | owner, editor |

Pairing is allowed while the event is Draft or Scheduled (to set up, and for rehearsal, FR-1721) or Live, never once it
has ended (`DV409 event_closed`).

## Rotating screen QR (T-309; FR-314; ADR-240)

### The code

- New purpose **0x07 `screen`** in `qr.ts` (`createScreenCodeKey`, `screenCode`, `verifyScreenCode`): id = the
  **quest id**, version = the **30-second window number** `floor(epoch seconds / 30)` (fits 4 bytes until the year
  6053). Its URL is `{DASHBOARD_ORIGIN}/s/{token}`; a phone camera opens the bilingual landing page `/[lang]/s/[token]`
  ("Scan this code inside the Questify app"), as `/q/`.
- **One clock**: the window is always taken from the **database** (`now()`), both when a code is issued and when it is
  judged. Neither the screen's clock nor the player's phone clock is ever used, so a TV whose clock is wrong still shows
  good codes, and API instances whose clocks drift cannot disagree. `screen_window()` answers `(window, ms_to_next)`;
  `screen_window_ok(version integer, at timestamptz)` (IMMUTABLE, tested at fixed instants) accepts the current window,
  and the previous one only while `at - window_start < interval '15 seconds'` exactly (accepted at 14.999 s, refused at
  15.000 s, both tested, CTO 7) of the current one (a player who scanned just before the
  change, on a slow network). So a code lives 30 seconds on the screen and dies at most 15 seconds after it changed.
- **A photographed code**: refused once it is more than 15 seconds past its change (FR-314's second case, `QV422
  expired`; the app says "This code has changed. Scan the screen again"). A code relayed live (a photo sent and scanned
  within those 45 seconds) still pays its scanner: accepted and written down (ADR-240); bounded by the quest's caps and
  period, and watched by T-209's burst flags. An organizer who wants presence proved by a person uses a staffed station
  or the kiosk (T-309b).
- Not single-use across players: a TV code is meant to be scanned by many. **One pay per player per window (CTO 6)**:
  for `screen_qr`, a completion of this quest by this enrollment with method `screen_qr` in the last 45 seconds
  answers `QD409` (in `record_completion`, under the enrollment lock), so one code cannot pay a repeatable quest twice;
  T-309b reuses the same rule for `kiosk`. Regenerating the quest's printed QR (FR-1711) does not touch screen codes
  (they carry no `qr_version`). Codes are per quest, not per screen: revoking one station stops its own codes, not the
  quest's codes on other stations or operators' phones (ADR-240 says so; "Revoke all" or turning `screen_qr` off stops
  them all).

### Showing it

- **Station page** `/[lang]/station` (paired as a station): the quest's title, its points, the QR large, a thin bar that
  empties over the 30 seconds, the label small in a corner, the event's name. `GET /v1/device/screen-code` (device) →
  `{code, url, changesInMs, quest: {title, points}}`; the page schedules the next fetch with a relative timer
  (`changesInMs` plus 0 to 1.5 seconds of jitter so a hall of screens does not ask together), never the device clock.
  Offline or on an error it keeps the current code only until the grace ends, then shows "Reconnecting…" and **no
  code** (never a dead one). It asks for the Screen Wake Lock where the browser has it. States: unpaired (the pairing
  code), paired and live, quest not open yet / ended / method off (a sentence, no code), event ended (blank page with the
  Questify mark). Big type for a TV across a room; RTL; Western digits.
- **Operator's phone** (app, Tools → "Rotating QR", FR-922): pick a quest (scan quests with `screen_qr` on, within the
  operator's limit; `show_rotating_qr` on), then the same full-screen code and bar. `GET
  /v1/operator/events/{eventId}/quests/{questId}/screen-code` (player bearer, operator check as `nfc_writer` with
  `show_rotating_qr`). The screen stays awake with `expo-keep-awake` if it ships in the current build without a new
  native build (checked at build; otherwise a hint "Keep your screen on" and no new module).
- `screen_code_for_device()` and `screen_code_for_operator(event, quest)` (definers, granted) check the device or
  operator, the quest's method and that the quest is open now (`quest_open_check` read-only parts: published, window,
  flash window, not a draft), and answer the quest id and `screen_window()`. The API signs. Each fetch is a read: no row
  is written per code. Limits: 6 a minute per device, 6 a minute per operator and quest.

### Scanning it (the player)

- The scanner (FR-621) reads `/s/` URLs beside `/q/` and `/t/` (only from the live camera, FR-303). `POST
  /v1/.../quests/{questId}/completions` gains the proof `{type: "screen", code}`: `verifyScreenCode` opens it for that
  quest (`not_questify`, `forged`, `wrong_quest` answer as a printed QR's do and count in the wrong-proof throttle);
  `complete_quest` admits `screen_qr` and passes the window as `proof_version`.
- `record_completion` restated (from 0056:106): the method check gains `(quest_row.type = 'scan_qr' AND proof_method =
  'screen_qr' AND 'screen_qr' = ANY (quest_row.verification))`, `IF proof_method = 'screen_qr' AND NOT
  screen_window_ok(proof_version, now()) THEN QV422 'expired'`, and the one-pay-per-window rule (CTO 6). The window is
  judged **inside the door, after the enrollment lock**, so no caller can skip it. `screen_qr` is boosted like a scan. The reserved key prefixes are
  unchanged.

## Big screen up to "paired" (T-309; ADR-241)

- `/[lang]/screen`: unpaired, the pairing code; paired, "Paired with {event}. The big screen starts here" with the
  event's name and the label, and nothing read from the ranking. T-504 replaces the paired state with its scenes and
  adds the screen's own reader rule and its outsider tests; this task gives it `request.device` of kind `screen`.
- **The big-screen link** (FR-630, FR-1713's "regenerate a big-screen link"): the link is the plain `/{lang}/screen`
  address; it holds nothing, so there is nothing to regenerate. The power sits in the pairing, and the dashboard's
  **Revoke all big screens** is the "regenerate" of FR-1713: every screen paired so far goes blank at its next request.
  FR-1713's wording is amended in the SRS (Q-202 asks).

## Kiosk (T-309b, split; FR-315; ADR-242) — design fixed here

### What proves the player: a live code, not My QR

My QR is fixed (ADR-137): a screenshot works for ever, which a staffed station accepts because the operator sees the
name and avatar. A kiosk has no one watching, and FR-315 says an expired screenshot must not pay. So the kiosk reads a
**live code**:

- New purpose **0x08 `live`**: id = the player id, version = the 30-second window, judged by the same
  `screen_window_ok` (one rule for both rotating codes). Stateless: nothing stored per code.
- The app's My QR screen gets a second tab, **"For kiosks"**, which shows the live code while online (`GET
  /v1/me/live-code` → `{code, changesInMs}`, the window from the database, 6 a minute per player), with the same
  emptying bar; offline it says "Kiosks need the internet. Staffed stations still read your My QR". The first tab (the
  fixed My QR) and every station and prize-desk scan are unchanged.
- A kiosk shown the fixed My QR (purpose 0x02 opens, 0x08 does not) answers "This kiosk reads your live code: My QR →
  For kiosks", and pays nothing. An expired live code answers "This code has expired. Show the new one".
- Honest ceiling: a friend relaying the live code by video within its 45 seconds can still pay its owner at a kiosk.
  Bounded by the caps, one pay per code (below) and T-209's flags; written down in ADR-242 (Q-201 asks whether kiosks
  should accept the fixed My QR instead, with ADR-137's risk).

### The kiosk page

- `/[lang]/kiosk` on any tablet browser (paired as a kiosk for one quest with `kiosk` on): the quest, "Show your live
  code to the camera", the camera view, and a result card for 4 seconds: green with the @username, avatar and points;
  orange "Already done"; red with the reason (expired code, needs the live code, not in this event, quest not open,
  limit reached). Never a score or balance. A web page, not the app: any tablet works, the pairing and credential are
  the station page's, and the store apps gain nothing that needs review.
- Camera decoding: **`zxing-wasm` 3.1.5** (MIT, 2026-10-06; 3.1.6 is younger than the 7-day cooldown), the
  `zxing-wasm/reader` subpath only (about 1 MiB of wasm), loaded only by the kiosk page, its wasm file **self-hosted**
  from the web app's `public/` (never the library's default CDN), read at 4 frames a second. New dependency (reason:
  Safari has no `BarcodeDetector`; one decoder everywhere). The kiosk route alone gets `Permissions-Policy:
  camera=(self)` and `script-src 'wasm-unsafe-eval'`; every other page keeps `camera=()`.
- The page drops a code it has just sent for 5 seconds (one held-up phone is one scan).

### The kiosk door (migration 0058)

- `verification` gains `kiosk` (on `scan_qr` only; with `quest_qr`, `screen_qr` or alone); the method check gains
  `kiosk`. `POST /v1/device/kiosk-scans {code}` (device of kind kiosk, **Idempotency-Key** per scan) → the result card's
  data. The API opens the code (0x08, else 0x02 for the "needs live code" answer, else `invalid_code`).
- `kiosk_complete_quest(scanned uuid, live_window integer, request_key text)` (definer, granted, `app_device_id()`
  required):
  1. reads its device row `FOR SHARE` (a Revoke waits for a scan in flight, or the scan sees `revoked`: either the scan
     paid before the revoke or is refused after it, never half); not a kiosk, revoked or ended → `DV401`; paired by an
     operator who no longer has `scan_quests` or the quest → `paused` (CTO 3);
  2. `ensure_rehearsal_wiped(device.event_id)` before anything is read about the player (T-308 code review 2);
  3. `record_completion(device.quest_id, scanned, 'kiosk', live_window, NULL, request_key, NULL, NULL, NULL, NULL,
     device.event_id)`: the enrollment lock, the quest re-read after the wipe, replay, `quest_open_check`, every cap;
  4. on a fresh completion, `kiosk_scan (completion_id PK → quest_completion ON DELETE CASCADE, device_id →
     paired_device ON DELETE SET NULL, organizer_id, event_id)`: which kiosk paid (the Devices page counts it; the wipe
     and erasure remove it with its completion, no restatement).
- `record_completion` restated again in 0058: the `kiosk` method row, `screen_window_ok` for `kiosk` too, and 0057's
  one-pay-per-window rule extended to `kiosk` (CTO 6), so a repeatable quest is not paid twice by one held-up code.
- Rate limits: 30 scans a minute per kiosk; 20 unreadable or forged codes in 10 minutes pause the kiosk for a minute
  ("Paused for a moment"); per player, the caps.
- Rehearsal: a kiosk paired before go-live pays rehearsal accounts in rehearsal; the wipe runs first at go-live.

## Every door and reader this reaches

| Path (latest file) | Change | Test (`test/db/devices.int.test.ts` unless said) |
|---|---|---|
| `record_completion` (0056), restated in 0057 (and 0058) | `screen_qr` method and window check (0058: `kiosk`, one pay per code) | the screen door table |
| `complete_quest` (0048), restated | admits `screen_qr` | `wrong_method` rows for `nfc`, `my_qr`, `kiosk` still refused |
| `operator_complete_quest` (0030) | unchanged (fixed My QR only) | a station scan of a live code is `invalid_code` (T-309b) |
| `quest_verification_known`, `quest_completion_method_check` | widened | builder rows; direct insert refused |
| `member_event_quests` (0055) | unchanged shape; `verification` lists `screen_qr` | the app's quest sheet says "Scan the code on the screen" |
| `staff_assignment` delete | new trigger revokes the operator's devices | removal test |
| `wipe_rehearsal`, `erase_rows`, event delete | unchanged (devices kept by the wipe; cascade on event and quest delete; `kiosk_scan` cascades with completions) | rows for each |
| New granted: `open_device_request`, `renew_device_request`, `device_session`, `activate_device`, `claim_device` (operator and team), `revoke_device`, `revoke_devices`, `event_devices`, `operator_devices`, `screen_code_for_device`, `screen_code_for_operator`; internal `screen_window`, `screen_window_ok` | | outsider and cross-tenant suites; the payer map gains `complete_quest → record_completion (screen_qr, now)`; T-306c's reader map gains the readers |

**The screen door table** (one table-driven test, a row per case): current window pays (`method = screen_qr`); the
previous window at 14 s pays and at 16 s is `expired`; two windows back, a future window, a wrong quest's code
(`wrong_quest`); a forged code; the quest with `screen_qr` turned off after the code was shown (`wrong_method`); hidden,
not started, ended, flash outside its window, category locked, not in the audience (each its `quest_open_check` code);
cap reached (`QD409`); retry with the same key (`replayed`); the same key on another quest (`QK422`); a boost in force
(×2); a rehearsal account during rehearsal and after go-live (the wipe first). `screen_window_ok` alone: a property
test over random instants (exactly the current window, plus the previous one only before second 15).

**The pairing table**: request → claim → session `paired`; an expired code; a claimed code claimed again (`DV404`); a
code of 7 or 9 characters; a station for a quest without `screen_qr`, outside the operator's limit, with
`show_rotating_qr` off; a big screen from staff mode (refused); an editor pairing; a viewer (refused); another
organizer's event (404); the device limit; an ended event; revoke then poll (`device_unpaired`); operator removal and
team-member removal (revoked, the delete succeeds, CTO 1); activation (old secret refused after the new one is used and
after 60 s, CTO 2); the pairing operator's ability off or quest taken out of the limit (`paused`, no code; back on,
codes again, CTO 3); unknown-code claims past 30 an hour per event and per organizer (CTO 8); a code-hash collision
retried (forced in the test); event end + 24 h; 30 idle days; the request flood cap and its alert line.

### Races and lock order

| Case | Outcome |
|---|---|
| Two staff claim one code at once | `claim_device` takes the request row `FOR UPDATE`; the second finds none: `DV404`. Crossed test. |
| A device polls while its code is claimed | the poll reads without locks: `pending` before the commit, `paired` after. |
| Activate while an old-secret request is in flight | `activate` takes the device `FOR UPDATE`; the old secret is checked against `previous_until` in the same row, so it is accepted or refused, never half. |
| Revoke while a station fetches a code | the fetch reads the device without a lock; a code fetched just before the revoke lives out its window (at most 45 s). Accepted and tested. |
| Revoke while a kiosk scans (T-309b) | the scan holds the device `FOR SHARE`, the revoke's update waits: paid before, refused after. Crossed both orders. |
| Operator removed while their kiosk scans | the removal trigger's update waits for the scan's `FOR SHARE`, as above. |
| Lock order | `claim_device`: the operator's assignment `FOR SHARE` (or the team check), the request `FOR UPDATE`, the event's device-count advisory lock, then the insert. `kiosk_complete_quest`: device `FOR SHARE` → (record_completion's) rehearsal row → enrollment. `revoke_device`: device `FOR UPDATE` only. No function takes a device after an enrollment, so none cycles. rules.md's lock-order paragraph gains these lines. |

## API (T-309)

- Public: `POST /v1/device/pairing {kind}` (sets the cookie; `Origin` checked, CTO 10; 60 per 10 minutes per address
  bucket, since a venue's screens share one address behind its NAT, and a call carrying a valid device cookie answers
  its state and is not counted, CTO 4; `503 busy` at the flood cap). It is public but writes only a request row that
  holds no one's data.
- Device: `GET /v1/device` (`{state: "pending", kind, code, expiresAt}`, `{state: "paired", activated: false}`, or
  `{state: "paired", activated: true, kind, label, paused, event: {name}, quest: {title, points} | null}`), `POST
  /v1/device/pairing/renew` (a new code for a pending device, same secret), `POST /v1/device/activate` (CTO 2), `GET
  /v1/device/screen-code`. 30 a minute per device for the poll.
- Operator: `POST /v1/operator/events/{eventId}/devices {code, kind, questId, label}` (**Idempotency-Key**; 10 a minute
  per operator), `GET …/devices`, `POST …/devices/{deviceId}/revoke`, `GET …/quests/{questId}/screen-code`.
- Team: `GET …/events/{eventId}/devices`, `POST …/devices {code, kind, questId?, label}`, `POST
  …/devices/{deviceId}/revoke`, `POST …/devices/revoke {kind?}` (all, or all big screens); owners and editors,
  **Idempotency-Key** on writes.
- Player: the completion route's new proof `screen`.
- Refusals in `http-errors.ts`: `device_unpaired` (401), `unknown_code` (404), `limit_reached`, `event_closed`,
  `not_screen_qr` (409), `ability_off` (403), `invalid_device {field}` (422).
- Platform switch `stations` in `packages/shared/src/config/registry.ts` (`gated: false`): off, station pages show "Not
  available" and the screen-code routes answer `403 feature_off`; pairing and the Devices page stay (so devices can
  still be revoked). No event switch: the quest's own `screen_qr` method is the organizer's. T-309b adds `kiosks`, T-504
  its own for the big screen. (ADR-076's paid add-ons gate them later, with activation.)
- `routes.int.test.ts` classifies every new route, its access kind and its limits; the inventory test proves a
  `device` route outside `/v1/device/` stops the server.
- Logs: the request serializer (`app.ts:126`) logs only the method and URL, never headers, and no new route carries a
  secret, code or token in its URL (all go in the body or the cookie); a test asserts the cookie value, a pairing code
  and a live or screen token never appear in a log line or an audit row.

## App and web (T-309)

- **App, staff mode**: Tools → "Pair a device" (scan or type the code; kind; quest; label; the client line; confirm),
  "Rotating QR" (quest picker, full-screen code), "My paired devices". The scanner reads `/pair#` URLs only inside
  "Pair a device". **Player**: the scanner reads `/s/` codes; the quest sheet's action for a `screen_qr` quest is "Scan
  the code on the screen". No new native module and no new permission (the camera is already granted), so an
  over-the-air update can carry it (checked: `expo-keep-awake` only if it is already in the build).
- **Web**: `/[lang]/station`, `/[lang]/screen`, the pairing state they share (one component), `/[lang]/s/[token]`
  landing page, `/[lang]/pair` (opened by a phone camera: "Open Questify, then Tools → Pair a device"), the dashboard's
  Devices page and the quest form's "QR on a screen (changes every 30 seconds)" method (ticking it unticks "Printed
  QR", with the hint "A printed code can be photographed and shared; the screen code changes every 30 seconds").

Strings (Arabic via `ux-araby` at build, Western digits, RTL checked; drafts):

| Key | English | Arabic |
|---|---|---|
| quests.verification.screenQr | QR on a screen (changes every 30 seconds) | رمز QR على شاشة (يتغير كل 30 ثانية) |
| quests.action.scanScreen | Scan the code on the screen | امسح الرمز الظاهر على الشاشة |
| scanner.screen.expired | This code has changed. Scan the screen again | تغيّر هذا الرمز. امسح الشاشة مجددًا |
| device.pair.waiting | Waiting to be paired | بانتظار الربط |
| device.pair.howTo | Ask the event team to pair this screen with this code | اطلب من فريق الفعالية ربط هذه الشاشة بهذا الرمز |
| device.kind.station | Station | محطة |
| device.kind.kiosk | Kiosk | كشك ذاتي |
| device.kind.screen | Big screen | الشاشة الكبيرة |
| device.reconnecting | Reconnecting… | جارٍ إعادة الاتصال… |
| device.methodOff | This quest no longer uses this screen | لم تعد هذه المهمة تستخدم هذه الشاشة |
| device.paired | Paired with {event} | مرتبطة بفعالية {event} |
| operator.devices.pair | Pair a device | ربط جهاز |
| operator.devices.mine | My paired devices | أجهزتي المرتبطة |
| operator.rotating | Rotating QR | رمز QR متغيّر |
| devices.revoke | Revoke | إلغاء الربط |
| devices.revokeScreens | Revoke all big screens | إلغاء ربط كل الشاشات الكبيرة |
| devices.removeNote | Devices they paired stop working | ستتوقف الأجهزة التي ربطها عن العمل |
| screen.landing | Scan this code inside the Questify app | امسح هذا الرمز من داخل تطبيق Questify |
| kiosk.needsLive (T-309b) | This kiosk reads your live code: My QR → For kiosks | يقرأ هذا الكشك رمزك المباشر: رمزي ← للأكشاك |
| myQr.kioskTab (T-309b) | For kiosks | للأكشاك |

Plus the Devices page's labels (Kind, Label, Quest, Paired by, Last seen, Revoke all) and the refusals.

## Store compliance

- The station page, the kiosk page and the big screen are **web pages** on organizer hardware; they are not in either
  store build. The apps gain staff-mode screens and a scanner case, no new permission, entitlement or native module,
  and nothing downloaded: the method is data, the code that reads it ships in the binary (STORE_COMPLIANCE gate, rules.md
  7). T-309b adds a tab to My QR, likewise no permission.
- App Review demo: the demo event's screen-QR quest is shown to the reviewer on a station page link in the review
  notes ("open this link on any screen and scan it"), paired beforehand by us; the review notes say stations are
  optional and every quest has another way in for the demo.
- Privacy answers unchanged: a device row names no person (the client line is a browser and system name); the kiosk's
  result card shows the @username, which is public on the boards already.

## Tests (test first, T-309)

- **Database** (`test/db/devices.int.test.ts`): the pairing table, the screen door table, `screen_window_ok`'s property
  test, the verification CHECK rows (screen with printed refused; screen on a non-scan quest refused), operator
  removal, cascades (quest, event), the wipe keeps devices, the payer and reader completeness maps, crossed locks (two
  claims; revoke vs fetch).
- **Security**: outsider (every new function, `anon` and `PUBLIC`; `device_request`, `paired_device` closed; the
  public pairing route can do nothing but make a request: a pending device's cookie opens no screen code, no event
  name, nothing); cross-tenant (claim into, list, revoke and fetch codes for another organizer's event all answer 404);
  a device of event A asking for a code of event B's quest (`screen_code_for_device` takes no quest argument, so it
  cannot).
- **Unit**: `qr.test.ts` gains `screen` (round trip, other purposes never open as a screen code, `wrong_quest`,
  canonical encoding); the pairing code alphabet and normaliser (case, dash and space ignored; the excluded letters
  refused); the User-Agent reducer (never more than browser and system).
- **Route**: every new route, `device_unpaired`, `feature_off`, the cookie's flags, the `Origin` check on device
  writes and on the public pairing POST, the log redaction, the reload case (a page with a valid cookie never makes a
  second request; a POST with a valid cookie answers the state and is not counted), 60 pairings from one address.
- **Cross-credential (CTO 11)**: a device cookie on every player, staff, member, owner and admin route → 401; a staff
  cookie or a player bearer on every `/v1/device` and `/v1/device/*` route → 401; a pending device's cookie on the
  paired-only routes → 401; the inventory test proves `/v1/devices` (no slash match) is not a device route.
- **App**: Pair a device (scan, type, kinds, refusals), Rotating QR, My paired devices, the scanner's `/s/` case, RTL
  and Arabic; `expo export`. **Web**: the station page states (unpaired, live, reconnecting, method off, ended), the
  big-screen paired state, the Devices page, the quest form's method; e2e `stations.spec.ts` (desktop and phone):
  pair a station from the dashboard, scan its code as a player through the API, revoke it and see the page go blank.
- **On a device** (not a CI gate): a station page on a TV browser and on an iPad, scanned by Android and iPhone from 3
  metres; the operator's phone code.
- **Mutation (GitHub)**: `apps/api/src/devices/**`, `apps/api/src/quests/qr.ts`, `apps/api/src/completions/complete.ts`.

## Phases (T-309; CTO code review once, at the end)

1. Migration 0057 + database, crossed-lock and security tests.
2. API: the `device` access kind, guard and pre-identity lookup, the pairing routes, the `screen` code purpose and
   proof, the operator and team routes, the switch, refusal mappings + route tests.
3. App (staff-mode Pair, Rotating QR, My devices; the scanner's `/s/`), web (station, screen, pair and `/s/` pages, the
   Devices page, the method box), strings; docs (API.md, DATA_MODEL.md `device_pairing` row replaced, SECURITY.md
   threat rows and the flood risk, SRS FR-314/FR-1713 status and FR-1713's rewording marked "pending Q-202" (FR-315's
   in T-309b, "pending Q-201"), FEATURES F-106/F-238, CONFIGURABILITY
   switch, rules.md lock order, STORE_COMPLIANCE notes, TASKS notes for T-309b and T-504, STATE).

## Proposed decisions and questions

- **ADR-238** T-309 is split: pairing (all three kinds), the device credential and the rotating screen QR stay in
  T-309; the kiosk and its live code move to T-309b (migration 0058, design fixed in this plan).
- **ADR-239** Device pairing: the device shows an 8-character code (10 minutes) and holds its own secret in an HttpOnly
  `__Host-qs_device` cookie (stored as its hash); staff claim the code from staff mode (stations with
  `show_rotating_qr`, kiosks with `scan_quests`, within the quest limit) or the dashboard (owners and editors, any
  kind; big screens only there). A device works until revoked, its operator removed, its quest or event deleted, 24
  hours after its event ends, or 30 idle days; its secret is replaced at activation; an operator's device pauses
  when the operator loses the ability or quest (CTO 1 to 4). A new `device` access kind under `/v1/device`.
- **ADR-240** Rotating screen QR: purpose 0x07, the quest id and the 30-second window, both taken from the database
  clock; the previous window is accepted for 15 seconds; not single-use; method `screen_qr` on scan quests only and
  never with the printed QR; one pay per player per window; codes are per quest, so revoking one station does not
  stop the others. A code relayed live within its 45 seconds still pays (risk accepted, caps and burst flags).
- **ADR-241** The big-screen link is the plain `/{lang}/screen` address and holds nothing; pairing holds the power, and
  "Revoke all big screens" replaces "regenerate the link" (amends FR-1713's wording).
- **ADR-242** (T-309b) Kiosks read a **live code** (purpose 0x08: the player id and the 30-second window, from My QR's
  "For kiosks" tab, online only), never the fixed My QR; method `kiosk` on scan quests; one pay per live code (45
  seconds); the kiosk is a web page with `zxing-wasm` 3.1.5 self-hosted, camera allowed on that route only. Amends
  FR-315 ("live code" for "live My QR"); ADR-137 stands for stations and the prize desk.
- **Q-201** Kiosks: read a live code from a "For kiosks" tab (recommended, an expired screenshot never pays), or read the
  fixed My QR as stations do and accept ADR-137's risk with no one watching?
- **Q-202** The big-screen link: a plain address plus pairing, with "Revoke all big screens" as the regenerate
  (recommended), or a link with a token that pairs the screen by itself (no staff step, but anyone holding the link
  opens it)?
- **Q-203** Screen QR: a 30-second code with 15 seconds' grace, and never together with the printed QR (so not with NFC,
  which needs the printed QR). Agree, or another rhythm (FR-314 allows 30 to 60 seconds), or allow NFC with the screen QR
  as its backup?
- **Q-204** Pairing from staff mode by operators with `show_rotating_qr` (stations) or `scan_quests` (kiosks), and
  removing an operator revokes what they paired. Agree, or a separate `pair_devices` ability (off by default), or
  pairing from the dashboard only?

## Build notes (2026-10-24)

- CTO plan re-review notes folded: (1) the removal triggers do nothing without active devices, and delete the devices of
  an event being deleted, so a cascaded delete never fails (tested: an event with operator- and team-paired devices, an
  operator's account erasure, a team member's removal and a staff user's delete); (2) `previous_hash` is UNIQUE (its
  index), accepted only while `previous_until > now()`, and a second activation with the old secret inside the 60 s
  draws a fresh secret without extending it (tested, crossed too); (3) SECURITY.md records the activation race.
- Deviations, as build notes on ADR-239 and ADR-240: the cookie is looked up by `device_session(hash)` (as
  `player_session_owner`), not a new pre-identity setting; a pending page's `GET` has no code (only hashes are stored)
  and a reload renews; a preview step (`POST …/devices/preview`) shows the client line before confirming; claims name
  the page's kind; staff mode pairs stations only until T-309b; the app's rotating code has no draining bar (the station page has it).
- Q-206: the platform tuning `screenQrRotationSeconds` was removed (CTO code review 5).
- CTO code review (86): renew and activate take 10 a minute per device and a request renews for at most an hour (MAJOR
  1; an hour, not 24, since one address bucket at 60 requests per 10 minutes could still hold 8,640 for a day); a renew
  losing a race for a code answers `code_taken`; the dashboard does not offer kiosks; `expo-keep-awake` on the
  operator's phone.
