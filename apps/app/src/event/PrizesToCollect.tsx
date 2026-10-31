import { formatEventTime, type Theme } from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { DeskLine } from "#src/event/DeskLine.tsx";
import {
  fetchHeldPrizes,
  isCollecting,
  type HeldPrize,
  type HeldPrizes,
} from "#src/event/held-prizes.ts";
import { startCollect } from "#src/event/shop-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * Reads the player's uncollected prizes on focus and when the app comes back to the front. A read that fails keeps what
 * the card showed. The clock moves on at the moment a live Collect runs out, so "Ready to collect" does not outlive it.
 */
function useHeldPrizes(eventId: string) {
  const [held, setHeld] = useState<HeldPrizes | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    const answer = await fetchHeldPrizes(api.session, eventId);
    if (answer.kind === "held") {
      setHeld(answer.held);
    }
    setNow(Date.now());
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void load();
      }
    });
    return () => watcher.remove();
  }, [load]);

  const nextEnd = (held?.prizes ?? [])
    .filter((prize) => isCollecting(prize, now))
    .map((prize) => Date.parse(prize.collectUntil ?? ""))
    .reduce((soonest, end) => Math.min(soonest, end), Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!Number.isFinite(nextEnd)) {
      return undefined;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextEnd - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [nextEnd]);
  return { held, now, load };
}

/** One prize: its name, its deadline or that it is ready at the desk, and Collect when the player confirms first. */
function PrizeRow({
  prize,
  desk,
  now,
  busy,
  onCollect,
}: Readonly<{
  prize: HeldPrize;
  desk: HeldPrizes["desk"];
  now: number;
  busy: boolean;
  onCollect: (id: string) => void;
}>) {
  const { t, language } = useI18n();
  const name = textIn(prize.name, language);
  const ready = isCollecting(prize, now);
  const deadline =
    prize.reservedUntil === null
      ? null
      : formatEventTime(new Date(prize.reservedUntil), desk.timeZone, language);
  return (
    <View style={{ gap: 4 }}>
      <AppText variant="label">{name}</AppText>
      {ready ? (
        <AppText muted>{t("shop.collecting")}</AppText>
      ) : deadline === null ? null : (
        <AppText muted>{t("win.collectBy", { deadline })}</AppText>
      )}
      {desk.confirm === "collect_first" ? (
        <Button
          label={t("shop.collect")}
          accessibilityLabel={`${t("shop.collect")}: ${name}`}
          disabled={busy || desk.state !== "open"}
          onPress={() => onCollect(prize.id)}
        />
      ) : null}
    </View>
  );
}

/**
 * Home's "Prizes to collect" (T-602d): what the player has reserved or won and not yet picked up, with the desk and
 * how to collect, whether or not the shop is on. With collect first each prize has Collect, which opens My QR ready for
 * the desk; with desk offers the player opens My QR and accepts there. Nothing shows when nothing is held.
 */
export function PrizesToCollect({ eventId }: Readonly<{ eventId: string }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const { held, now, load } = useHeldPrizes(eventId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const collect = async (id: string) => {
    setBusy(true);
    setProblem(null);
    const result = await startCollect(api.session, id);
    setBusy(false);
    if (result.kind === "signed_out") {
      router.replace("/home");
    } else if (result.kind === "done") {
      router.push("/my-qr");
      void load();
    } else {
      setProblem(
        result.kind === "refused" && result.problem !== null
          ? result.problem[language]
          : t("join.network"),
      );
    }
  };

  if (held === undefined || held.prizes.length === 0) {
    return null;
  }
  return (
    <View style={styles.card}>
      <AppText variant="title">{t("heldPrizes.title")}</AppText>
      <DeskLine desk={held.desk} />
      {held.desk.confirm === "collect_first" ? (
        <AppText muted>{t("shop.collectHint")}</AppText>
      ) : (
        <>
          <AppText muted>{t("shop.offerHint")}</AppText>
          <Button label={t("heldPrizes.openMyQr")} onPress={() => router.push("/my-qr")} />
        </>
      )}
      {held.prizes.map((prize) => (
        <PrizeRow
          key={prize.id}
          prize={prize}
          desk={held.desk}
          now={now}
          busy={busy}
          onCollect={(id) => void collect(id)}
        />
      ))}
      {problem === null ? null : <AppText accessibilityRole="alert">{problem}</AppText>}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.navigationActive,
    backgroundColor: theme.colors.highlight,
  },
});
