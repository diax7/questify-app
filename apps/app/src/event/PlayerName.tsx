import { shownName, type NameDisplay } from "@questify/shared";
import type { StyleProp, TextStyle } from "react-native";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import { AppText } from "#src/components/AppText.tsx";

type Props = Readonly<{
  username: string;
  fullName: string | null;
  names: NameDisplay;
  /** Drawn after the name on the same line, such as a worn title. */
  suffix?: string;
  variant?: "label";
  style?: StyleProp<TextStyle>;
}>;

/**
 * A player's name on one line as the event names players (FR-1842): `@username`, the full name, or both. A full name
 * the server did not send (a player who was not told, or an event on usernames) is never drawn, and a missing one falls
 * back to the username. The username is Latin and stays left to right inside an Arabic row, so "@" stays in front.
 */
export function PlayerName({ username, fullName, names, suffix = "", variant, style }: Props) {
  const shown = shownName(fullName, names);
  const handle = isolatedLtr(`@${username}`);
  const text =
    shown.fullName === null
      ? handle
      : shown.showUsername
        ? `${shown.fullName} · ${handle}`
        : shown.fullName;
  return (
    <AppText
      {...(variant === undefined ? {} : { variant })}
      numberOfLines={1}
      adjustsFontSizeToFit
      style={[style, shown.fullName === null ? { writingDirection: "ltr" } : null]}
    >
      {text}
      {suffix}
    </AppText>
  );
}
