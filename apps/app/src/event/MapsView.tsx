import {
  formatEventTime,
  formatNumber,
  type MemberMap,
  type MemberMaps,
  type MemberMapPin,
  type Theme,
} from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { Amount } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { fetchMaps, isHere, mapToShow, pinGlyph, pinName, pinStatus } from "#src/event/maps.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The brand's padlock (icon-padlock, 128 px), on a pin for a locked quest; decorative, the pin's words say "Locked". */
const PADLOCK = require("#assets/icons/padlock.png");

const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
const BOARD_SIZE = 40;

/** Reads the maps on focus, every 30 seconds, and when a completion has paid (a quest pin's state changes). */
function useMapReads(eventId: string) {
  const { paidCount } = useEvent();
  const [data, setData] = useState<MemberMaps>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = async () => {
        const read = await fetchMaps(api.session, eventId);
        if (!active) return;
        if (read.kind === "signed_out") router.replace("/sign-in");
        else if (read.kind === "maps") setData(read.data);
        setFailed(read.kind === "network");
      };
      void load();
      const timer = setInterval(() => void load(), 30_000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [eventId, attempt]),
  );
  useEffect(() => {
    if (paidCount > 0) setAttempt((value) => value + 1);
  }, [paidCount]);
  return { data, failed, reload: () => setAttempt((value) => value + 1) };
}

function PinMark({
  pin,
  here,
  label,
  onPress,
}: Readonly<{ pin: MemberMapPin; here: boolean; label: string; onPress: () => void }>) {
  const styles = useThemedStyles(makeStyles);
  const status = pinStatus(pin);
  const tone =
    status === "done" ? styles.pinDone : status === "open" ? styles.pinOpen : styles.pinPlain;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={[
        styles.pin,
        tone,
        here && styles.pinHere,
        { left: `${pin.x / 10}%`, top: `${pin.y / 10}%` },
      ]}
    >
      {status === "locked" ? (
        <Image
          accessibilityElementsHidden
          importantForAccessibility="no"
          source={PADLOCK}
          resizeMode="contain"
          style={styles.padlock}
        />
      ) : (
        <AppText variant="label" style={styles.glyph}>
          {pinGlyph(pin)}
        </AppText>
      )}
    </Pressable>
  );
}

/** The plain board of one map: pins by thousandths of its size. A map is a plan, never mirrored for Arabic. */
function Board({
  data,
  map,
  onOpen,
}: Readonly<{ data: MemberMaps; map: MemberMap; onOpen: (pin: MemberMapPin) => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      accessibilityLabel={t("mapsView.board", { name: textIn(map.name, language) })}
      style={styles.board}
    >
      {map.pins.map((pin) => (
        <PinMark
          key={pin.id}
          pin={pin}
          here={isHere(data, pin)}
          label={pinLabel(pin, isHere(data, pin), t, language)}
          onPress={() => onOpen(pin)}
        />
      ))}
    </View>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

/** What a screen reader says for a pin: its name, its quest's status, and "You are here" on the last scanned one. */
function pinLabel(pin: MemberMapPin, here: boolean, t: Translate, language: "ar" | "en"): string {
  const name = pinName(pin, language, t);
  const status = pinStatus(pin);
  const named =
    status === null ? name : t("mapsView.pin", { name, status: t(`mapsView.status.${status}`) });
  return here ? t("mapsView.hereBadge", { name: named }) : named;
}

function PinSheet({
  pin,
  here,
  eventId,
  onClose,
}: Readonly<{ pin: MemberMapPin; here: boolean; eventId: string; onClose: () => void }>) {
  const { t, language } = useI18n();
  const status = pinStatus(pin);
  const details = pin.details === null ? "" : textIn(pin.details, language);
  return (
    <Sheet visible title={pinName(pin, language, t)} onClose={onClose}>
      {here ? <AppText variant="label">{t("mapsView.here")}</AppText> : null}
      {status === null ? null : <AppText>{t(`mapsView.status.${status}`)}</AppText>}
      {pin.quest === null ? null : (
        <Amount amount={formatNumber(pin.quest.points, language)} form="compact" muted />
      )}
      {details === "" ? null : <AppText>{details}</AppText>}
      {pin.quest === null ? null : (
        <Button
          label={t("mapsView.openQuest")}
          onPress={() => {
            onClose();
            router.push(`/event/${eventId}/quests?quest=${pin.quest?.id ?? ""}`);
          }}
        />
      )}
    </Sheet>
  );
}

function MapPicker({
  data,
  shown,
  onPick,
}: Readonly<{ data: MemberMaps; shown: MemberMap; onPick: (id: string) => void }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (data.maps.length < 2) return null;
  return (
    <ScrollView
      horizontal
      contentContainerStyle={styles.chips}
      showsHorizontalScrollIndicator={false}
    >
      {data.maps.map((map) => (
        <Button
          key={map.id}
          kind={map.id === shown.id ? "primary" : "quiet"}
          selected={map.id === shown.id}
          label={textIn(map.name, language)}
          onPress={() => onPick(map.id)}
        />
      ))}
    </ScrollView>
  );
}

function MapsStatus({
  failed,
  loading,
  empty,
  reload,
}: Readonly<{ failed: boolean; loading: boolean; empty: boolean; reload: () => void }>) {
  const { t } = useI18n();
  return (
    <>
      {failed ? (
        <>
          <AppText accessibilityRole="alert">{t("mapsView.loadFailed")}</AppText>
          <Button label={t("common.retry")} onPress={reload} />
        </>
      ) : null}
      {loading && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
      {empty ? <AppText muted>{t("mapsView.empty")}</AppText> : null}
    </>
  );
}

/** When the player last scanned, said under the board of the map that holds the marker. */
function HereNote({
  data,
  shown,
  eventId,
}: Readonly<{ data: MemberMaps; shown: MemberMap; eventId: string }>) {
  const { t, language } = useI18n();
  const { events } = useEvent();
  const zone = events?.find((event) => event.id === eventId)?.timezone ?? deviceZone();
  if (data.here === null || !shown.pins.some((pin) => isHere(data, pin))) return null;
  const time = formatEventTime(new Date(data.here.at), zone, language);
  return <AppText muted>{t("mapsView.hereAt", { time })}</AppText>;
}

function PinRows({
  data,
  shown,
  onOpen,
}: Readonly<{ data: MemberMaps; shown: MemberMap; onOpen: (pin: MemberMapPin) => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (shown.pins.length === 0) return null;
  return (
    <>
      <AppText variant="title">{t("mapsView.pinsTitle")}</AppText>
      {shown.pins.map((pin) => {
        const status = pinStatus(pin);
        return (
          <Pressable
            key={pin.id}
            accessibilityRole="button"
            accessibilityLabel={pinLabel(pin, isHere(data, pin), t, language)}
            onPress={() => onOpen(pin)}
            style={styles.row}
          >
            <AppText variant="label">{pinName(pin, language, t)}</AppText>
            {status === null ? null : <AppText muted>{t(`mapsView.status.${status}`)}</AppText>}
          </Pressable>
        );
      })}
    </>
  );
}

/**
 * The event's maps for a player (FR-821, FR-823 to FR-827): switch by name, a plain board with pins, a quest pin that
 * shows done, open or locked with its points, "You are here" at the last scanned station, and a reference only (no
 * route, no live position). In the Quests tab `onOpenQuest` opens the quest's own sheet; on its own screen a pin opens
 * its details and a quest pin offers to open the quest.
 */
export function MapsView({
  eventId,
  onOpenQuest,
}: Readonly<{ eventId: string; onOpenQuest?: (questId: string) => void }>) {
  const styles = useThemedStyles(makeStyles);
  const reads = useMapReads(eventId);
  const [pickedId, setPickedId] = useState<string>();
  const [sheetPinId, setSheetPinId] = useState<string>();
  const data = reads.data;
  const shown = data === undefined ? undefined : mapToShow(data, pickedId);
  const sheetPin = shown?.pins.find((pin) => pin.id === sheetPinId);
  const open = (pin: MemberMapPin) => {
    if (pin.quest !== null && onOpenQuest !== undefined) onOpenQuest(pin.quest.id);
    else setSheetPinId(pin.id);
  };
  return (
    <View style={styles.list}>
      <MapsStatus
        failed={reads.failed}
        loading={data === undefined}
        empty={data !== undefined && shown === undefined}
        reload={reads.reload}
      />
      {data === undefined || shown === undefined ? null : (
        <>
          <MapPicker data={data} shown={shown} onPick={setPickedId} />
          <Board data={data} map={shown} onOpen={open} />
          <HereNote data={data} shown={shown} eventId={eventId} />
          <PinRows data={data} shown={shown} onOpen={open} />
        </>
      )}
      {sheetPin === undefined || data === undefined ? null : (
        <PinSheet
          pin={sheetPin}
          here={isHere(data, sheetPin)}
          eventId={eventId}
          onClose={() => setSheetPinId(undefined)}
        />
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  list: { gap: theme.spacing.md },
  chips: { gap: theme.spacing.sm },
  board: {
    width: "100%" as const,
    aspectRatio: 4 / 3,
    // A map is a plan: pins keep their place whatever the language's direction.
    direction: "ltr" as const,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  pin: {
    position: "absolute" as const,
    width: BOARD_SIZE - 6,
    height: BOARD_SIZE - 6,
    marginLeft: -(BOARD_SIZE - 6) / 2,
    marginTop: -(BOARD_SIZE - 6) / 2,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: theme.radius.pill,
    borderWidth: 2,
    borderColor: theme.colors.text,
  },
  pinPlain: { backgroundColor: theme.colors.surface },
  pinDone: { backgroundColor: theme.colors.primaryAction },
  pinOpen: { backgroundColor: theme.colors.highlight },
  pinHere: { borderWidth: 4, borderColor: theme.colors.hot },
  glyph: { textAlign: "center" as const },
  padlock: { width: 18, height: 18 },
  row: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
