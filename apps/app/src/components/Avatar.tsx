import type { Avatar as AvatarName, Theme } from "@questify/shared";
import { Image, View, type ImageSourcePropType } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { avatarFace } from "#src/components/avatar-face.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The six default avatars (FR-117), from the brand set, trimmed and reduced to 128 px (T-116). */
const IMAGES: Readonly<Record<AvatarName, ImageSourcePropType>> = {
  falcon: require("#assets/avatars/falcon.png"),
  fox: require("#assets/avatars/fox.png"),
  camel: require("#assets/avatars/camel.png"),
  owl: require("#assets/avatars/owl.png"),
  lantern: require("#assets/avatars/lantern.png"),
  "explorer-hat": require("#assets/avatars/explorer-hat.png"),
};

/**
 * A player's avatar in a circle, whole (never cropped). An avatar this app version does not know shows the username's
 * first letter instead (F-282). Decorative: the row around it names the player.
 */
export function Avatar({
  name,
  username,
  size,
}: Readonly<{ name: string; username: string; size: number }>) {
  const styles = useThemedStyles(makeStyles);
  const face = avatarFace(name, username);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}
    >
      {face.kind === "letter" ? (
        <AppText variant="label">{face.letter}</AppText>
      ) : (
        <Image
          source={IMAGES[face.avatar]}
          resizeMode="contain"
          style={{ width: size * 0.86, height: size * 0.86 }}
        />
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  circle: {
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
});
