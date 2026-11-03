# T-802 - Player onboarding intro (plan, tier B)

Delivers FR-138 (superseded by FR-1798), FR-1798 to FR-1802 and the text half of FR-1803 (F-82, F-305, F-306, F-307;
ADR-096). App only: no migration, no route, no table. ADR-590 to ADR-594 and Q-550 to Q-552 Proposed.

## What exists and is reused

- Launch: `app/index.tsx` decides where a cold start opens (Home, or the player's live event). A join link never
  reaches it: `+native-intent.tsx` sends `https://questify.sa/{lang}/e/{CODE}` straight to `/join/{CODE}?via=link`.
- Legal: terms and privacy are accepted at sign-up (T-110) and on a new version (`ReacceptGate`, any signed-in route).
  The intro runs before sign-in, collects nothing and sits under `ReacceptGate` like every screen.
- Language: `useI18n().switchLanguage` saves the choice and restarts (ADR-110); the phone's language is preselected by
  `decideBoot`. Local flags live in AsyncStorage (`keyValueStore`; cleared by an uninstall, which is "once per install").
- Texts: every `MESSAGES` key is editable in the console's translation matrix (T-702), grouped by the key's first word,
  so the cards' texts under `onboarding.` are admin-editable data with a shipped fallback (FR-1766, FR-1768).
- Look: the adventure theme roles (parchment surface, wood frame, gold rim, green action), Baloo Bhaijaan 2 and Rubik,
  `useReduceMotion`, and the 3D icons the app already ships (`compass`, `ach-first-steps`, `crownCoin`, `gift`). The
  mascot is still Q-069, so the art is those icons, as the coin and the tab bar are placeholders elsewhere (ADR-013).

## Design

1. **State** (`src/onboarding/intro-state.ts`): one AsyncStorage key `questify.intro`, `"language"` (the choice step is
   done, the app may have restarted for it) or `"seen"`. `introDue` is false when the store cannot be read: a broken
   store must never trap a player in an intro (no blocking). The cards mark `"seen"` the moment the first card shows, so
   the intro appears at most once per install even if the app is killed half way; Settings replays it.
2. **Cards** (`intro-cards.ts`): four cards, each a message key pair and an icon; the join variant swaps card 1 for
   "You're in {event}". Pure and tested: every key exists in both languages, Western digits, no permission wording.
3. **Flow** (`intro-flow.ts`): steps, next/back, and where each ending goes: Skip and the last card's actions take the
   organic player to Home, the scanner (`/home` then `/join-scan`, so back never leaves the app) or Explore; the join
   variant ends at the event; a replay ends where it started (`router.back`) or at the chosen action.
4. **Screen** (`IntroScreen.tsx`, route `app/intro.tsx`): a Skip action on every step, a language step (Arabic and
   English each named in itself, the current one selected, a restart note when the choice differs), then the cards:
   parchment panel in a wood frame with a gold rim, the icon popping in (still under Reduce Motion), progress dots,
   Back and Next, the last card's two actions. Layout follows the language's direction; digits are Western.
5. **Entry points**: the launch screen sends a first launch to `/intro`; the join card's and invitation's "Go to the
   event" open `/intro?event=&name=` first when the intro is due (join-link variant, FR-1801); Settings (the profile
   screen) gets "How Questify works" for everyone, signed in or not (`/intro?replay=1`: four cards, no language step).
6. **Store compliance**: no permission, no network call, no analytics (a source scan test forbids importing the
   notification, camera, location, NFC or tracking modules in the intro folder); nothing stored but the flag.

## Decisions taken without Dhia (Proposed)

- ADR-590: join link order follows ADR-096 (event preview and join first, then the intro, then the event) over the
  coordinator's shorthand "intro, then the join card"; the join card is also the first thing a player on a bad network
  needs. Flipping it is one function (`afterJoinRoute`). Q-550.
- ADR-591: the join variant has no language step (that step belongs to the first organic launch, FR-1798, and a restart
  after joining would drop the event) and its first card names the event.
- ADR-592: marked seen when the cards start, not when they end.
- ADR-593: order and hiding of cards (the layout-controls half of FR-1803) is split to T-802b: it needs a platform
  setting, a door and a console page (a migration), which this task does not have. Q-551.
- ADR-594: replay is a plain route over the app; Settings is the profile screen (no separate Settings screen exists).
  Q-552: the cards' art is a placeholder until the mascot is chosen (Q-069).

## Tests

State (missing, `language`, `seen`, unreadable store, a failing write), cards (keys, both languages, the variant),
flow (steps, bounds, endings per variant and replay), the route builders (an event id and name from params are checked
and capped), a source scan (no permission modules), the Hermes guard (existing). `expo export --platform android`
builds the screen. Nothing can be checked on a phone from this session.
