import type { TextStyle, ViewStyle } from "react-native";
import type { PlatformName } from "#src/platform/capabilities.ts";

/** The bottom inset a phone browser reports for the home indicator and gesture bar (0 where there is none). */
const INSET = "env(safe-area-inset-bottom, 0px)";

/**
 * The style of the bottom bar (FR-620). One left-to-right order in both languages, so `direction` stays `ltr` (ADR-110
 * note, Q-100: Home on the left in Arabic too). On the web the navigator does not know the phone's bottom inset and
 * gives the bar 49 points, which cuts the labels off; the bar gets room for an icon and a label plus the inset.
 */
export function tabBarStyle(backgroundColor: string, platform: PlatformName): ViewStyle {
  const base: ViewStyle = { backgroundColor, direction: "ltr" };
  if (platform !== "web") {
    return base;
  }
  return {
    ...base,
    height: `calc(72px + ${INSET})` as unknown as number,
    paddingTop: 6,
    paddingBottom: `calc(8px + ${INSET})` as unknown as number,
  };
}

/**
 * The label under a tab icon. On the web the navigator lets the label shrink to its font size and clips the text,
 * which cuts the tails of letters (the y of Journey, the last letter of Arabic words); a line height and a box a
 * little taller fix it. A phone keeps the navigator's own label.
 */
export function tabBarLabelStyle(
  label: Readonly<{ fontFamily: string; fontSize: number; lineHeight: number }>,
  platform: PlatformName,
): TextStyle {
  const base: TextStyle = { fontFamily: label.fontFamily, fontSize: label.fontSize };
  return platform === "web"
    ? { ...base, lineHeight: label.lineHeight, height: label.lineHeight + 4, flexShrink: 0 }
    : base;
}
