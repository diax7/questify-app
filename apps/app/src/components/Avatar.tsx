import type { Avatar as AvatarName, Theme, Equipment } from "@questify/shared";
import { Image, View, type ImageSourcePropType } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { avatarLook } from "#src/components/avatar-look.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The six default avatars (FR-117), from the brand set, trimmed and reduced to 128 px (T-116). */
const IMAGES: Readonly<Record<AvatarName, ImageSourcePropType>> = {
  falcon: require("#assets/avatars/falcon.webp"),
  fox: require("#assets/avatars/fox.webp"),
  camel: require("#assets/avatars/camel.webp"),
  owl: require("#assets/avatars/owl.webp"),
  lantern: require("#assets/avatars/lantern.webp"),
  "explorer-hat": require("#assets/avatars/explorer-hat.webp"),
};

/**
 * A player's avatar in a circle, whole (never cropped). An avatar this app version does not know shows the username's
 * first letter instead (F-282). Decorative: the row around it names the player.
 */
export function Avatar({
  name,
  username,
  size,
  equipment,
}: Readonly<{ name: string; username: string; size: number; equipment?: Equipment | undefined }>) {
  const styles = useThemedStyles(makeStyles);
  const { chosen, face, radius, border, borderColor, ring, motif } = avatarLook(
    name,
    username,
    size,
    equipment,
  );
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: radius,
          borderWidth: border,
          borderColor: borderColor ?? styles.circle.borderColor,
        },
      ]}
    >
      {ring === null ? null : <View pointerEvents="none" style={ring} />}
      {motif === null ? null : <View pointerEvents="none" style={motif} />}
      {chosen === "chest" ? (
        <Image
          source={require("#assets/games/cards/chest.webp")}
          resizeMode="contain"
          style={{ width: size * 0.72, height: size * 0.72 }}
        />
      ) : face.kind === "letter" ? (
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
