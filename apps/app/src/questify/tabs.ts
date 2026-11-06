import type { Ionicons } from "@expo/vector-icons";
import type { MessageKey } from "@questify/shared";

type Icon = keyof typeof Ionicons.glyphMap;

/**
 * The bar outside events (FR-830, T-408b, T-404d): Home, Explore, Scan in the middle, Journey and Profile, in one
 * left-to-right order in both languages (ADR-110 note; Q-100). Each name is a route file of `app/(questify)`. Placeholder
 * icons until the 3D icon set from the brand deck is ready (ADR-013).
 */
export const QUESTIFY_TABS: ReadonlyArray<
  Readonly<{ name: string; title: MessageKey; icon: Icon }>
> = [
  { name: "home", title: "nav.home", icon: "home" },
  { name: "explore", title: "nav.explore", icon: "compass" },
  { name: "scan", title: "nav.scan", icon: "scan" },
  { name: "journey", title: "nav.journey", icon: "ribbon" },
  { name: "profile", title: "nav.profile", icon: "person" },
];
