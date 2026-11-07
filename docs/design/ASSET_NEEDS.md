# Art the product still needs

Audit of the code on 2026-11-07. The art set lives in gitignored folders on Dhia's PC (`docs/design/assets`,
`docs/design/codex-image-2`, `ASSET_LIST.md`), so this list says what the code uses and lacks, not what exists there. The last
count in the repo is 115 of about 218 done on 2026-10-16, then 179 reviewed that night: 133 keep, 44 redo, 1 remove
(`docs/_blueprint/STATE.md`).

## In the repo and used

36 files in `apps/app/assets`: achievements 5, avatars 6, currency 5, games 13, icons 3 (padlock, flame, lightning), brand 4.
The app icon, Android adaptive icon and web icons are final art.

## Blocks store submission (T-806)

- Store screenshots in Arabic and English, taken from the real app, with a fictional organizer (`docs/STORE_COMPLIANCE.md`).
- Play feature graphic and store icon exports. Sizes are not set in the repo; check each store's current rules.

## Seen by every player

| Need | Stands in today | Where |
|---|---|---|
| 3D tab bar icons, player and operator, 5 each | Stock Ionicons, marked placeholder (ADR-013) | `app/event/[eventId]/(tabs)/_layout.tsx:20`, `app/operator/[eventId]/(tabs)/_layout.tsx:12`, `src/questify/tabs.ts:9-17` |
| Level shield | Two "shield" glyphs and a number | `LevelBadge.tsx:22-25` |
| 3D phone icon | Padlock | `app/devices.tsx:35-36,71` |
| Medal | Ionicons "medal" | `AchievementRewards.tsx:43` |
| More achievement badges, 192 px | First letter of the name | `AchievementBadge.tsx:55-56` |
| Saqr poses (ADR-130) for the intro cards | Existing icons | `IntroArt.tsx:8-13` |
| Saqr for permission and empty states | Plain text | `Camera.tsx:40-48`, `LockerScreen.tsx:217`, `EventHistoryScreen.tsx:55`, `Agenda.tsx:260`, `Announcements.tsx:161` |

The total number of planned achievements is not stated in the code.

## Nice to have

Amenity and map pin icons (emoji today, `apps/app/src/event/maps.ts:50-62`), home quick-link icons (`HomeBlocks.tsx:213-222`), frame
and character item art, wizard preview mocks (Q-357 (d)), a 1024 px splash (`splash.png` is 482 px), an Open Graph share image,
RTL-mirrored ornaments, the Saudi cultural set, venue and event-type icons, animation parts (compass, chest lid).

## Not art

T-305b, T-504b, T-506b, T-507b, T-602b, T-610b and T-613b are organizer uploads waiting on photo storage (Q-149, Later).

## Fixes needing no new art

The daily challenge spinner uses a coin emoji though `coin.png` exists (`motion.tsx:125`).

## Stale notes

Q-069 was decided by ADR-130 (Saqr), but Q-552 and risk R16 still read as open.
