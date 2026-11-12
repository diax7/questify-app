import type { Theme } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { Image, Switch, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { fetchPhotoWall, type WallPhoto, type WallRead } from "#src/event/photo-wall-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { BlockButton } from "#src/questify/BlockButton.tsx";
import { ReportButton } from "#src/questify/ReportButton.tsx";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The player's choice for one photo (T-504b, ADR-084's per-photo choice): its words name both places the photo can
 * appear, the big screen and the app's photo wall (plan section 7, M4). Off by default.
 */
export function OnScreenSwitch({
  on,
  disabled,
  onChange,
}: Readonly<{ on: boolean; disabled: boolean; onChange: (on: boolean) => void }>) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <AppText style={styles.label}>{t("photoWall.switch")}</AppText>
      <Switch
        accessibilityLabel={t("photoWall.switch")}
        value={on}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: theme.colors.border, true: theme.colors.primaryAction }}
      />
    </View>
  );
}

/** One photo: the picture, whose it is, Report (the store's UGC report path) and Block. */
function WallItem({ photo, onBlocked }: Readonly<{ photo: WallPhoto; onBlocked: () => void }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const by = photo.username === null ? null : t("photoWall.photoBy", { name: photo.username });
  return (
    <View style={styles.item}>
      <Image
        source={{ uri: photo.url }}
        style={styles.picture}
        resizeMode="cover"
        accessibilityLabel={by ?? t("photoWall.title")}
      />
      {by === null ? null : <AppText muted>{by}</AppText>}
      <ReportButton subject={{ kind: "media", targetId: photo.mediaId }} />
      {photo.username === null ? null : (
        <BlockButton username={photo.username} onChange={(blocked) => blocked && onBlocked()} />
      )}
    </View>
  );
}

function WallBody({
  read,
  reload,
  drop,
}: Readonly<{ read: WallRead | undefined; reload: () => void; drop: (id: string) => void }>) {
  const { t } = useI18n();
  if (read === undefined) return null;
  if (read.kind === "off") return <AppText>{t("photoWall.offApp")}</AppText>;
  if (read.kind === "failed") {
    return (
      <>
        <AppText accessibilityRole="alert">{t("photoWall.loadFailed")}</AppText>
        <Button kind="quiet" label={t("common.retry")} onPress={reload} />
      </>
    );
  }
  if (read.photos.length === 0) return <AppText>{t("photoWall.emptyApp")}</AppText>;
  return (
    <>
      {read.photos.map((photo) => (
        <WallItem key={photo.mediaId} photo={photo} onBlocked={() => drop(photo.username ?? "")} />
      ))}
    </>
  );
}

/**
 * Home's way into the event's photo wall (T-504b, FR-637): the photos the team picked for the big screen, from players
 * who allowed it, without the players this player blocked. Each photo can be reported to Questify and its owner blocked
 * (STORE_COMPLIANCE 1.2). Read when opened; the links last at most two minutes, so a reopen reads again.
 */
export function PhotoWallEntry({ eventId }: Readonly<{ eventId: string }>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<WallRead | undefined>(undefined);
  const load = useCallback(async () => {
    setRead(await fetchPhotoWall(api.session, eventId));
  }, [eventId]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const drop = (username: string) =>
    setRead((before) =>
      before?.kind === "photos"
        ? { kind: "photos", photos: before.photos.filter((one) => one.username !== username) }
        : before,
    );
  return (
    <>
      <Button kind="quiet" label={t("photoWall.title")} onPress={() => setOpen(true)} />
      <Sheet visible={open} title={t("photoWall.title")} onClose={() => setOpen(false)}>
        <WallBody read={read} reload={() => void load()} drop={drop} />
      </Sheet>
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: theme.spacing.md,
  },
  label: { flex: 1 },
  item: { gap: theme.spacing.sm },
  picture: {
    width: "100%" as const,
    aspectRatio: 4 / 3,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
  },
});
