# Design References — Questify

Put reference images in `docs/design/references/`. Each one gets a row here: what it is, what we
take from it, and what we don't.

## References

| # | File | What it is | Take from it | Avoid |
|---|---|---|---|---|
| R-01 | `references/Questify-brand-deck.pdf` (16 pages, 2026-10-16) | **The brand guideline.** Logo, app icon, palette, UI kit, 3D icons, six mock app screens, the analytics dashboard, the user journey, booth and uniform concepts | The whole visual identity (ADR-013) | The conflicts listed below |

## R-01 — what the deck establishes

**Style.** A casual mobile-game UI with a fantasy-adventure theme. The surfaces are physical
materials (wood planks, parchment, polished gold), with vines as ornament, chunky glossy 3D
icons, and bevelled buttons. The closest benchmarks are the menus of Royal Match, Hay Day and
Clash of Clans. Search terms: "casual game UI", "fantasy game GUI kit", "2.5D game icons".

**Brand assets**
- Wordmark: chunky gold "Questify"; the Q's tail is a magnifying glass.
- App icon: the gold Q on a wood tile with vines.
- Emblem: a wooden shield with a gold "!" (quest marker).
- Tagline: "Turn Every Event Into an Adventure".

**Palette**

| Token | Hex | Seen used for |
|---|---|---|
| Treasure Gold | `#FFC94D` | Logo, coins, highlights, active tab |
| Honey Glow | `#FFA93C` | Gold shading, warm accents |
| Adventure Orange | `#FF7A3D` | Emphasis, "hot" tags |
| Wood Brown | `#8B5A2B` | Headers, frames, navigation bar. The uniform slide lists `#BB5A2B`; the palette slide wins |
| Leaf Green | `#68C05B` | Primary action (GO), progress bars, ribbons |
| Treasure Blue | `#4AA5E6` | Secondary action (CLAIM), gems |
| Map Cream | `#FFF5E1` | Page and card backgrounds (parchment) |

**UI kit (deck p16):**
- buttons: primary green, secondary blue, inactive cream, all bevelled with a gold rim;
- ribbon banners, tabs, a "NEW" tag, speech bubble, parchment panel with a crown;
- XP bar with a star-level badge, coin balance pill, "+500" reward toast;
- level shield, count badge, toggles, checkboxes, radios, padlock, ornate frames and dividers;
- about 40 3D icons: magnifier, map pin, chest, shields, speech, coin, backpack, scroll, trophy,
  compass, potion, crystal, medal, check, gift, sword, key, crown, ticket, money bag, book,
  lightning, gear, heart, gem, bomb, wing, target, coin stack.

**Screen patterns:**
- wood header with the logo and coin balance;
- ribbon section titles and parchment cards with a wood frame;
- illustrated hero banners for events and quests;
- a five-tab wooden bottom navigation;
- a dark-wood overlay for the QR scanner;
- a gold-medallion "Quest Complete!" celebration.

## Conflicts in the deck (to fix in the design, not copy)

| Item | Issue | Tracked |
|---|---|---|
| "+" next to the coin balance | Reads as "buy coins"; there are no payments | Q-053 |
| Golden Ticket ("enter special raffles"), Mystery Box, Spin the Wheel | Chance-based prizes | ADR-008, Q-052 |
| "Share on Social Media" quest | Rewarding shares may break platform rules | Q-054 |
| "Defeat 10 monsters", "Use 5 potions", "Travel 50 km" | Placeholder game content; real quests are event actions | — |
| Dense small text on textured wood | Contrast and Dynamic Type; real screens carry fewer items than the mockups | Stage 4 |
| Directional ornaments (arrows, ribbons, vines) | Need mirrored versions for Arabic (RTL) | Stage 4 |
| Latin-only display lettering | Needs an Arabic display face with the same chunky gold treatment | Stage 4 |
