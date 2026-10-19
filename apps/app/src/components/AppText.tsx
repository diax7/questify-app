import { Text, type TextProps } from "react-native";
import { colors, typography, type TextVariant } from "#src/theme/tokens.ts";

type Props = TextProps & { variant?: TextVariant; muted?: boolean };

/** All text goes through this, so type and colour come from the tokens and never from a screen. */
export function AppText({ variant = "body", muted = false, style, ...rest }: Props) {
  return (
    <Text
      {...rest}
      style={[typography[variant], { color: muted ? colors.textMuted : colors.text }, style]}
    />
  );
}
