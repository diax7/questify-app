import { EMPTY_EQUIPMENT, type ProfileItem, type Theme } from "@questify/shared";
import { Image, View, type ImageSourcePropType } from "react-native";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import type { Me } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

const PADLOCK: ImageSourcePropType = require("#assets/icons/padlock.webp");

/**
 * An item as it will look on the player: a frame or a character on their own avatar, a title on a name plate (which
 * names the title, so the card around it does not say it again; see `previewNamesItem`). A locked item is faded with a
 * padlock on it, unless the card already shows one (`padlock` false). Decorative: the card carries the spoken label.
 */
export function ItemPreview({
  item,
  me,
  size,
  locked,
  padlock = locked,
}: Readonly<{ item: ProfileItem; me: Me; size: number; locked: boolean; padlock?: boolean }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const body =
    item.kind === "title" ? (
      <View style={styles.plate}>
        <AppText variant="label" numberOfLines={1} style={{ writingDirection: "ltr" }}>
          {isolatedLtr(`@${me.username}`)}
        </AppText>
        <AppText variant="label" numberOfLines={2}>
          {item.name[language]}
        </AppText>
      </View>
    ) : (
      <Avatar
        name={me.avatar}
        username={me.username}
        size={size}
        equipment={{ ...(me.equipment ?? EMPTY_EQUIPMENT), [item.kind]: item }}
      />
    );
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.slot}
    >
      <View style={[styles.shrink, locked ? styles.faded : null]}>{body}</View>
      {padlock ? (
        <Image
          source={PADLOCK}
          resizeMode="contain"
          style={[styles.padlock, { width: size * 0.4, height: size * 0.4 }]}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  slot: { flexShrink: 1, alignItems: "center" as const, justifyContent: "center" as const },
  shrink: { flexShrink: 1 },
  faded: { opacity: 0.4 },
  padlock: { position: "absolute" as const },
  plate: {
    maxWidth: 140,
    flexShrink: 1,
    gap: 2,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.background,
  },
});
