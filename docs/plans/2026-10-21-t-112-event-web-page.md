# T-112 — The event web page: join link, link preview, store buttons, install prompt

Delivers the web side of FR-113, FR-114, FR-115, FR-116 and FR-1741. The app side (reading the Android install referrer,
the iPhone paste offer on first open, universal and app links opening the join card) waits for the app shell (T-009)
and the store accounts (T-010), and stays noted on T-111. Standard bar (a public read-only page); the code lookup it
uses is T-111's, already throttled.

## Scope note

- **The join link exists** (`https://questify.sa/{ar|en}/e/{CODE}`, `joinLink`/`parseJoinLink`, T-111) and nothing
  serves it yet. This page is it: the QR and the invite link land here on a phone without the app.
- **Reuse:** `GET /v1/public/events/{joinCode}` (the card: name, venue, dates, status, access, join methods and the
  join card text), the web shell (TopBar, language in the URL, RTL, the design tokens), the server-to-server pattern of
  `fetchMe` (internal API origin, the browser's `X-Forwarded-For` passed on, a timeout, no cache), `formatEventTime`.
- **Not yet:** the event banner and its brand colours (T-602), prizes (T-201), the real store links (T-010: the app is
  not in the stores), `apple-app-site-association` and `assetlinks.json` (they need the Apple team id and the signing
  key, T-010). Each is a note on its task.

## Decisions (tactical; for the CTO to challenge)

1. **The page `/[lang]/e/[code]`**, server-rendered: the event's name, venue, dates in its zone (Western digits), its
   status (upcoming, live now, ended), the join code in large type, and the join card's "the organizer will see" list,
   so the person knows before installing. Private events show too (the code is the secret, FR-105, FR-115). An unknown
   code, a draft or archived event: a plain "this event is not available" page with a 404 status (FR-103). A malformed
   code: the same 404, with no API call.
2. **The visitor's address reaches the API:** the server fetch passes the request's `X-Forwarded-For` (as `fetchMe`),
   so T-111's wrong-code budget counts the visitor, not the web server. A 429 from the API shows "too many wrong codes
   from this network, try again in a few minutes" with a 429 status. The answer is cached for nobody (`no-store`):
   the status changes over time and the API's own cost is one indexed read.
3. **Link preview (FR-116):** `generateMetadata` writes the title (the event's name in the page's language, falling back
   to the other), a description (venue and date), `og:` and `twitter:` tags, the canonical join link, `og:locale`
   (`ar_SA` / `en_US`), and a default share image from the brand (one static PNG in `public/`, 1200×630) until event
   banners exist (T-602 replaces it per event, and FR-116's "new banner in the preview" lands there). A missing event
   gets no preview tags beyond the site name.
4. **Store buttons (FR-115, FR-113):** the App Store and Google Play links come from the web app's settings
   (`APP_STORE_URL`, `PLAY_STORE_URL`), read and checked at start like `API_ORIGIN` (https only, the stores' hosts).
   Unset (today) means no buttons and a line "the app is coming to the stores soon". The Play link carries the install
   referrer `referrer=join%3D{CODE}` (FR-113's automatic Android path: the app reads it on first open).
5. **iPhone paste flow (FR-114):** a "Copy the code and get the app" button writes `questify:{CODE}` to the clipboard
   (a user gesture, so iOS allows it) and then opens the App Store link; the app offers to paste it on first open
   (T-111). Without the stores, the button only copies, and says it did. Typing the code by hand always works.
6. **Install prompt (FR-1741):** before the event starts, the page heads with "Get ready: install Questify" and the
   store buttons; while it is live, "The event is on now". Opening the app directly when installed is the universal or
   app link (T-010), not this page.
7. **Arabic first:** every string in both languages through the message table (ux-araby), RTL checked, Western digits.

## Tests

- Unit: the store settings reader (missing, http, foreign host, valid), the Play referrer URL, the clipboard text, the
  metadata builder (both languages, fallbacks, a missing event).
- e2e on desktop and phone: a live public event in Arabic and English (name, code, status, the card list), a private
  one by its code, an unknown code (404), a malformed one, the preview tags in the HTML head, the copy button copying
  `questify:{CODE}` (the clipboard permission in Playwright), the "coming soon" line with no store settings, and the
  buttons with the referrer when they are set.
- The API sees the visitor's address: an e2e request with a set `X-Forwarded-For` that misses 60 times is throttled,
  while another address is not (or a unit test of the fetch helper passing the header, if the e2e is too slow).

## Phases

1. **Page and helpers:** the fetch helper, the settings reader, the page, metadata, the copy button, messages, tests.
2. **Docs:** API.md is unchanged; DEPLOYMENT or RUNBOOK names the two web settings; TASKS notes on T-010
   (association files, store links), T-111 (referrer and paste on first open), T-201 (prizes on the page), T-602 (the
   banner and the per-event share image); STATE.

## Revision 1 (after CTO plan review 1, 81/100) — overrides the sections above where they differ

- **M1, the clipboard holds the join link:** the copy button writes `joinLink(CODE, lang)`, the format `parseJoinLink`
  already reads (Q-070: "the event page copies the link"), so the app's paste offer accepts it and a paste elsewhere still
  works. Tested as a round trip through `parseJoinLink`.
- **M2:** an App Router page cannot answer 429 or 503: a throttled or unavailable lookup renders its message with Next's
  status and `robots: noindex`. Only "not available" is a 404 (`notFound()`).
- **M3, the share image ships:** Next's file convention `app/[lang]/e/[code]/opengraph-image.png` (1200×630, under
  300 KB, made from `docs/design/assets/marketing/store-screenshot-backdrop.png` and the wordmark, reviewed at full size),
  emitted by the build, so no `public/` folder; `metadataBase` is the join link's origin so `og:image` is absolute.
  T-602 replaces it with an `opengraph-image.tsx` per event.
- **M4, an unreachable API:** the helper answers `found | not_found | throttled | unavailable`, checks the answer's
  shape (as `readMe` does), times out after 5 seconds. `unavailable` still renders the code, the store and copy
  buttons, and "we couldn't load the event details, try again".
- **M5, one API call per view:** the lookup is wrapped in React `cache()` keyed by the code and the forwarded chain, so
  the page and `generateMetadata` share it and a wrong code counts once.
- **M6:** `app/[lang]/e/[code]/not-found.tsx` says "not available" in Arabic and English, stacked, each with its own
  `lang` and `dir` (a segment's not-found gets no params). Next's English default 404 for the other pages goes to
  OPEN_QUESTIONS (Q-097).
- **m1:** no user-agent sniffing: a Google Play button (with the referrer) and an "iPhone: copy the code and open the
  App Store" button, side by side. **m2:** a rejected clipboard write says so and shows the link selected for a manual
  copy, without opening the store; the store opens only after the write finished. **m3:** `robots: noindex` for
  unlisted and private events (the code is the secret); public events may be indexed. **m4:** `ended` shows "This event
  has ended", no install headline, no copy button, the store buttons stay; the code is upper case everywhere shown, in
  the canonical and in the clipboard. **m5:** `appStoreUrl` and `playStoreUrl` are optional fields of `readWebConfig`
  (https, `apps.apple.com` / `play.google.com` only); the referrer is set with `searchParams.set`. **m6:** the official
  store badges come with the real links (a note on T-010; STORE_COMPLIANCE). **m7:** no 60-miss e2e; a unit test of the
  helper (it sends `x-forwarded-for`; it maps 200, 404, 429, 5xx, a timeout and a wrong shape); the e2e asserts
  `og:image` is absolute and answers 200.
- **Nits:** the canonical and `og:url` name `questify.sa` (staging previews point there: the RUNBOOK says so);
  `alternates.languages` for ar and en; TASKS marks T-112 "web half done".

## Result (2026-10-21)

CTO: plan 81 → 93; phases 92, 95 (GO). Found while building: a missing `Retry-After` read as a 0-second wait (the
helper now answers `throttled` without a time, and the page says "a few minutes"); the preview is tested as a WhatsApp
bot fetches it, raw HTML with no JavaScript; ADR-019 settles the Arabic brand name (the new copy follows it; Q-098
lists six older strings that drift). The share image is 86 KB, composed from the marketing backdrop and the wordmark,
reviewed at full size.
