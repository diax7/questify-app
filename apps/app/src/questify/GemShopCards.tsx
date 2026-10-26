import { EMPTY_EQUIPMENT, type GemShopItem, type Theme } from "@questify/shared";
import { View } from "react-native";
import type { Me } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { GemIcon } from "#src/questify/GemIcon.tsx";
import { gemsLabel } from "#src/questify/gems.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** A frame or a character on the player's own avatar, a title on a name plate. */
export function ItemPreview({ item, me }: Readonly<{ item: GemShopItem; me: Me }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (item.kind === "title") {
    return (
      <View style={styles.plate}>
        <AppText variant="label">@{me.username}</AppText>
        <AppText variant="title">{item.name[language]}</AppText>
      </View>
    );
  }
  const equipment = { ...(me.equipment ?? EMPTY_EQUIPMENT), [item.kind]: item };
  return <Avatar name={me.avatar} username={me.username} size={64} equipment={equipment} />;
}

/** One item for sale: its preview, name and price in gems, then "Get" or "Owned". No money is ever named. */
export function ShopCard({
  item,
  me,
  disabled,
  onGet,
}: Readonly<{ item: GemShopItem; me: Me; disabled: boolean; onGet: () => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const price = gemsLabel(t, item.price, language);
  return (
    <View style={styles.card}>
      <ItemPreview item={item} me={me} />
      <AppText variant="title">{item.name[language]}</AppText>
      <View accessible accessibilityLabel={t("gemShop.price", { gems: price })} style={styles.row}>
        <GemIcon size={20} />
        <AppText variant="label">{price}</AppText>
      </View>
      {item.owned ? (
        <AppText muted>{t("gemShop.owned")}</AppText>
      ) : (
        <Button
          label={t("gemShop.get")}
          accessibilityLabel={t("gemShop.getLabel", { name: item.name[language], gems: price })}
          disabled={disabled}
          onPress={onGet}
        />
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: theme.spacing.xs },
  plate: {
    alignSelf: "flex-start" as const,
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.background,
  },
});
