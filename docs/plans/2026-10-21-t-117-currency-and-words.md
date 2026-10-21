# T-117 — The event's currency and its renamed words

Delivers FR-404, FR-405, FR-940, FR-941 (ADR-058, F-24, F-186). Standard bar; the write is an organizer power within
tenant isolation (Max for its authorization, as every organizer route).

## Scope note

- **Today:** amounts show as "Points: 10" / «النقاط: 10» everywhere: Home, quest cards and sheets, the scanner's
  celebration, the history and the ranking. The dashboard says "player" in about ten strings (the players page, the
  builder's "per player" and "visible to players", the ranking switch); the app's own copy hardly names players. No
  operator screen exists yet (T-205).
- **Art:** the five icons FR-405 names exist in the brand set: coin (`icon-coin-star`), crown coin, gem, leaf
  (`currency-leaf-token`), star (`currency-xp-star`). The star is also the conventional XP symbol (ASSET_INDEX); FR-405
  keeps it as a currency choice, and the clash goes to Q-105.
- **Not here:** renaming "quest" and "category" (ADR-058 names them, but FR-940 asks for player and operator only;
  they get a requirement first: Q-105 too); the big screen (T-5xx) uses the same terms when it exists.

## Decisions (tactical; for the CTO to challenge)

1. **The data: one `terms` object per event,** stored in `event.config.terms` (the event's configuration document, so
   the app reads it with everything else and the last working copy covers it):
   `{currency: {icon, ar: {one, many}, en: {one, many}}, player: {ar: {one, many}, en: {one, many}}, operator: {…}}`.
   A shared schema (`EventTerms`, zod) validates it: every form 1 to 30 characters after trimming, no digits, no
   `{`/`}` (they would break message placeholders), icon one of `coin | crownCoin | gem | leaf | star`. Saving needs
   all forms of a word, or none for it (the defaults stay); FR-404 and FR-940 ask for the missing form.
2. **Defaults** (Questify's own words, used on Questify home and for any event that sets none): currency «نقطة /
   نقاط», "point / points", icon `coin`; player «لاعب / لاعبون», "player / players"; operator «مشغّل / مشغّلون»,
   "operator / operators" (ux-araby).
3. **The API:** `PUT /v1/organizers/:organizerId/events/:eventId/terms` (owner or editor within their event limit; a
   strict body; any status but archived, since a name can be fixed after the event; audited `event.terms.update` with
   before and after). The event read (`GET …/events/:eventId`) carries `terms`. The composed configuration
   (`GET /v1/config?event=`) gains `terms`, always complete (defaults filled), schema version still 1 (an added key).
4. **Arabic grammar (ADR-058):** a renamed noun is only ever used where it reads right with no article, agreement or
   counting:
   - as a label before a colon: «{currencyMany}: 120», «{playerMany}: 34»;
   - as a heading on its own: the players page title is the plural as the organizer typed it.
   Every sentence that would need «الـ» or a number agreement is rephrased instead, checked with ux-araby. English
   uses one/many by count ("1 point", "12 points").
5. **The app:**
   - `EventProvider` loads the event's composed configuration (`loadConfig` with `?event=`, its last working copy) and
     gives `useTerms()`.
   - One `Amount` component shows the icon beside a number with the currency name by the rules above. It replaces the
     "Points: N" strings on Home, quest cards and sheets, the celebration, the history and the ranking. Questify
     home has no event, so it uses the defaults.
   - An icon the app does not know falls back to `coin` (F-282).
   - The icons are 128 px copies in `apps/app/assets/currency/`, reviewed at full size first.
6. **The dashboard:**
   - An "Event words" section on the event page: the currency (both languages, both forms, and the icon picked from
     the five images, with no upload anywhere, FR-405), player and operator.
   - It saves through the route above. A missing form is named before anything is sent.
   - The players page title and its empty state use the event's player word (FR-941); the builder's and ranking
     switch's strings are rephrased so they need no player noun.

## Tests

- Shared: the schema (full, partial word, digits, braces, too long, unknown icon); `termsOf(config)` fills defaults;
  the label and count rules (`amountText`: Arabic label form, English one or many).
- API: the route (owner, editor, an editor outside their limit, another organizer, archived, a bad body, audit before
  and after), the event read, the composed configuration with and without terms; the route inventory.
- App: `useTerms` from a config and from defaults; `Amount`'s text in both languages; an unknown icon.
- Web e2e: rename the currency and the player in Arabic, see them on the players page and on the event page.

## Phases

1. Shared schema and defaults, the API route, configuration, tests, mutation.
2. The dashboard section and the players page, e2e.
3. The app (`useTerms`, `Amount`, the screens), tests, `expo export`.
4. Docs: API.md, DATA_MODEL, CONFIGURABILITY, TASKS, Q-105, STATE.

## Revision 1 (after CTO plan review 1, 84/100): overrides the sections above where they differ

- **M1, one cache slot per scope:** `loadConfig` takes `event`; the platform copy stays at `questify.config`, an event's
  at `questify.config.<eventId>`, each with its own ETag. Tested: offline, event B never shows A's terms; the platform
  copy survives an event load.
- **M2, a tolerant read:**
  - `terms` is optional in `composedShape`, with a per-word `catch`, so a copy from before T-117 still parses and one
    bad word falls back to its default.
  - On the server, `readEventTerms(stored)`, beside `readEventSwitches`, does the same.
  - `termsOf(config)` fills the defaults.
  - Tested: no terms, malformed terms, one bad word.
- **M3, every string, decided:** the table below. `points.balance` and its tests are deleted: they put a counted noun
  after a number.
- **m1:** `saveEventTerms` sits in the settings service beside `saveEventSwitch`:
  - it locks the row and writes `jsonb_set(config, '{terms}', …)`;
  - it bumps `config_version`, calls `forgetAll()`, and audits only a real change;
  - an invalid body answers 422 `invalid_terms` with the field, so the dashboard names the missing form.
- **m2, the save rules:**
  - The icon is optional and saved on its own.
  - Names follow all-or-none per word.
  - PUT replaces the whole terms object: a word left out returns to its default. The dashboard always sends the whole
    form.
- **m3, a form's text:**
  - Trimmed, 1 to 30 characters.
  - No digits of any script (`\p{Nd}`), no control characters or line breaks, no bidi override or isolate characters
    (U+202A–202E, U+2066–2069).
  - No `{` or `}`: not for safety, which `interpolate` already gives, but so text stays text.
- **m4, a live preview:** under the fields, showing «جواهر: 120» and the players page title as players and the team
  will see them. The organizer may type «الطلاب» if they want the definite form. The default label becomes «نقاط: 120»
  (it was «النقاط: 120»).
- **m5, no flash:** `useTerms` serves the event's cached copy first, then revalidates; until either exists it shows
  the defaults, never an empty label.
- **m6, two forms of `Amount`:**
  - compact (icon and number), for ranking rows and quest cards;
  - labelled (the word and the number), for Home, the history and the celebration.
  - Accessibility labels always carry the word.
- **Nits:**
  - The icons are already in `apps/app/assets/currency/` and `apps/web/public/currency/`.
  - CONFIGURABILITY's as-built note says an admin override of a changed key falls back to the shipped text.
  - `terms` is returned on the single-event read only.

### The strings (L = the event's word in label form, «{word}: N»; H = heading, the word alone; R = rephrased with no
noun; K = kept, outside an event or Questify-level)

| Key | Where | Rule | Arabic / English after |
|---|---|---|---|
| `eventHome.points` | app Home | H | `{currency}` (the many form) |
| `quests.pointsShort` | app cards, dashboard builder | L | «{currency}: {points}» / "{currency}: {points}" |
| `questsTab.summary` | app Quests | L | «{currency}: {earned} / {available} · المهام: …» / "{earned} / {available} {currency} · …" |
| `questsTab.completed` | app sheet, scanner | L | «{currency}: ‎+{points}» / "+{points} {currencyByCount}" |
| `ranking.rowLabel`, `rowLabelMe` | app ranking (spoken) | L | «…، {currency}: {score}» / "…, {score} {currencyByCount}" |
| `players.points` | dashboard column | H | `{currency}` |
| `quests.field.points` | dashboard builder | H | `{currency}` |
| `players.title` | dashboard | H | `{players}` (the many form) |
| `quests.repeatShort` | app and builder | L | «المرات لكل {player}: {count}» / "Times per {player}: {count}" (also ends a number agreement bug) |
| `quests.field.repeatCap` | builder | L | «أقصى عدد مرات لكل {player}» / "Most times per {player}" (لكل with an indefinite singular reads right) |
| `eventHome.noRank` | app | R | «أنجز مهمة لتدخل الترتيب.» / "Complete a quest to get a rank." |
| `scanner.otherEvent` | app | R | «احتُسب هذا الرمز في فعالية أخرى من فعالياتك.» / "This code counted in another of your events." |
| `history.title` | app | R | «السجل» / "History" |
| `history.empty` | app | R | «لا شيء هنا بعد. أنجز مهمة لتبدأ.» / "Nothing here yet. Complete a quest to start." |
| `history.other` | app | R | «تعديل في الرصيد» / "Balance change" |
| `ranking.empty` | app | R | «الترتيب فارغ بعد. كن الأول!» / "The ranking is empty so far. Be the first!" |
| `events.end` body | dashboard | R | «…ولن يُكمل أحد مهامها بعدها…» / "…nobody can complete its quests after that…" |
| `players.banBody` | dashboard | R | «يختفي اسمه من الترتيب ولا يُكمل مهام في هذه الفعالية. يبقى سجله، ويمكنك رفع الحظر لاحقًا.» / "Their name leaves the boards and they cannot complete quests in this event. Their record stays, and you can lift the ban later." |
| `players.empty` | dashboard | R | «لم ينضم أحد بعد.» / "No one has joined yet." |
| `players.noMatch` | dashboard | R | «لا أحد بهذا الاسم.» / "No one has that username." |
| `players.loadFailed` | dashboard | R | «تعذّر تحميل القائمة. حاول مرة أخرى.» / "The list could not be loaded. Try again." |
| `players.ownerOnly` | dashboard | R | «الحظر متاح لمالك الجهة المنظِّمة فقط.» / "Only the organizer's owner can ban." |
| `events.ranking.label`, `.shown`, `.hidden` | dashboard | R | «إظهار الترتيب في التطبيق» / «الترتيب ظاهر في التطبيق.» / «الترتيب مخفي في التطبيق.»; "Show the ranking in the app" / "The ranking shows in the app." / "The ranking is hidden in the app." |
| `quests.liveBanner`, `quests.liveBody` | dashboard | R | «الفعالية جارية: يظهر كل تغيير في التطبيق فورًا.» / «يظهر هذا التغيير في التطبيق فورًا. هل تريد المتابعة؟»; "The event is live: every change shows in the app at once." / "This change shows in the app at once. Go ahead?" |
| `quests.pinnedHidden` | dashboard | R | «مخفية، فلن تظهر مهمةً تالية حتى تُظهرها.» / "It's hidden, so it won't show as Up next until you show it." |
| `quests.field.visible` | dashboard | R | «ظاهرة في التطبيق» / "Visible in the app" |
| QR quest help (line 402) | dashboard | R | «تُكمَل بمسح رمز QR الخاص بها.» / "Completed by scanning its QR code." |
| entry-code help (line 407) | dashboard | R | «…لا يظهر في التطبيق.» / "…It never shows in the app." |
| regenerate warning (line 828) | dashboard | R | «…أعد طباعته قبل استخدامه في الفعالية.» / "…Reprint it before it is used at the event." |
| `quests.invalid.points` | dashboard | R | «أدخل رقمًا من 0 إلى 100000.» / "Enter a number from 0 to 100000." |
| `signOut.body`, `signIn.profileTitle`, the join card (line 19), the web QR page (line 856) | Questify-level or outside an event | K | unchanged |
| `points.balance` | tests only | delete | — |

English `{currencyByCount}` is the one form for exactly 1, else the many form; Arabic never counts a renamed noun.
