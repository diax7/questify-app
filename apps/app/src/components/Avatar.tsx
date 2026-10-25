import type { Avatar as AvatarName, Theme, Equipment } from "@questify/shared";
import { Image, View, type ImageSourcePropType } from "react-native";
import { frameDesign } from "@questify/shared";
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
  equipment,
}: Readonly<{ name: string; username: string; size: number; equipment?: Equipment | undefined }>) {
  const styles = useThemedStyles(makeStyles);
  const chosen = equipment?.character?.visualKey ?? name;
  const face = avatarFace(chosen, username);
  const frame = frameDesign(equipment?.frame?.visualKey);
  const radius = frame?.rounded === false ? size * 0.25 : size / 2;
  const border = frame === null ? 1 : Math.max(1, size * 0.06);
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
          borderColor: frame === null ? styles.circle.borderColor : "#8B5A2B",
        },
      ]}
    >
      {frame === null ? null : (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: Math.max(0, radius - border),
            borderWidth: border,
            borderColor: frame.color,
            borderStyle: frame.double ? "dashed" : "solid",
          }}
        />
      )}
      {frame?.motif === true ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            width: Math.max(2, size * 0.08),
            height: Math.max(2, size * 0.08),
            backgroundColor: "#8B5A2B",
            transform: [{ rotate: "45deg" }],
          }}
        />
      ) : null}
      {chosen === "chest" ? (
        <Image
          source={require("#assets/games/cards/chest.png")}
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
