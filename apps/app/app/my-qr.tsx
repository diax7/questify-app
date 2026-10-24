import { useKeepAwake } from "expo-keep-awake";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, ScrollView, useWindowDimensions, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { MY_QR_KEY } from "#src/api/session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { QrCode } from "#src/components/QrCode.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { DeskItems } from "#src/event/DeskItems.tsx";
import {
  LIVE_RETRY_MS,
  fetchLiveCode,
  liveCodeLifeMs,
  nextLiveFetchMs,
} from "#src/event/live-code.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useTheme } from "#src/theme/theme.tsx";
import { fetchMyQr, resetMyQr } from "#src/operator/operator-api.ts";
import { playerOfCode } from "#src/operator/station.ts";

const store = {
  read: () => SecureStore.getItemAsync(MY_QR_KEY).catch(() => null),
  write: (token: string) =>
    SecureStore.setItemAsync(MY_QR_KEY, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }).catch(() => undefined),
};

/** What For kiosks shows: the live code (and when it was fetched), why there is none, or the wait. */
type Live =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "code"; code: string; changesInMs: number; at: number }>
  | Readonly<{ kind: "offline" }>
  | Readonly<{ kind: "off" }>;

/**
 * The live code loop (T-309b, ADR-242): fetch on open, again when the code changes (plus jitter), timed from each
 * answer and never by the phone's clock. Online only: nothing is cached, and without a fresh answer the code is dropped
 * once its window and grace have passed. It runs only while the screen is in front; leaving it stops the timer.
 */
function useLiveCode(attempt: number): Live {
  const [live, setLive] = useState<Live>({ kind: "loading" });
  useFocusEffect(
    useCallback(() => {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let held: Extract<Live, { kind: "code" }> | undefined;
      const later = (ms: number) => {
        timer = setTimeout(() => void read(), ms);
      };
      const read = async () => {
        const answer = await fetchLiveCode(api.session);
        if (stopped) {
          return;
        }
        if (answer.kind === "code") {
          held = {
            kind: "code",
            code: answer.code,
            changesInMs: answer.changesInMs,
            at: Date.now(),
          };
          setLive(held);
          later(nextLiveFetchMs(answer.changesInMs, Math.random()));
          return;
        }
        if (answer.kind === "off") {
          held = undefined;
          setLive({ kind: "off" });
          return;
        }
        const alive = held !== undefined && Date.now() - held.at < liveCodeLifeMs(held.changesInMs);
        if (!alive) {
          held = undefined;
        }
        setLive(held ?? { kind: "offline" });
        later(answer.kind === "slowed" ? answer.waitMs : LIVE_RETRY_MS);
      };
      void read();
      return () => {
        stopped = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };
    }, [attempt]),
  );
  return live;
}

/** The emptying bar under the live code, restarted with each new code; it is drawn from the answer's timing. */
function EmptyingBar({ ms, size }: Readonly<{ ms: number; size: number }>) {
  const { theme } = useTheme();
  const fill = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    fill.setValue(1);
    const run = Animated.timing(fill, { toValue: 0, duration: ms, useNativeDriver: false });
    run.start();
    return () => run.stop();
  }, [fill, ms]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.border,
        overflow: "hidden",
      }}
    >
      <Animated.View
        style={{
          height: "100%",
          backgroundColor: theme.colors.highlight,
          width: fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
        }}
      />
    </View>
  );
}

/** For kiosks (T-309b): the live code, the screen kept awake, and what to do when there is none. */
function KioskCode() {
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  useKeepAwake();
  const [attempt, setAttempt] = useState(0);
  const live = useLiveCode(attempt);
  const size = Math.min(width - 72, 320);
  return (
    <>
      {live.kind === "loading" ? <AppText muted>{t("common.loading")}</AppText> : null}
      {live.kind === "code" ? (
        <>
          <View style={{ padding: 12, backgroundColor: "#ffffff", borderRadius: 12 }}>
            <QrCode text={live.code} size={size} label={t("myQr.kioskTab")} />
          </View>
          <EmptyingBar key={live.code} ms={live.changesInMs} size={size} />
          <AppText>{t("myQr.kioskHint")}</AppText>
        </>
      ) : null}
      {live.kind === "offline" ? (
        <>
          <AppText accessibilityRole="alert">{t("myQr.kioskOffline")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={() => setAttempt((n) => n + 1)} />
        </>
      ) : null}
      {live.kind === "off" ? (
        <AppText accessibilityRole="alert">{t("myQr.kioskOff")}</AppText>
      ) : null}
    </>
  );
}

/**
 * My QR (FR-306, ADR-137): the player's fixed code, which an operator scans at a station. Showing it only says who the
 * player is; prizes need the player's own confirmation, shown under the code (T-206). A code someone else saw can be
 * changed at once. The For kiosks tab (T-309b) shows the live code a kiosk reads instead.
 */
export default function MyQrScreen() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<"fixed" | "kiosk">(params.tab === "kiosk" ? "kiosk" : "fixed");
  return (
    <Screen title={t("myQr.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16, alignItems: "center" }}>
        <View
          style={{ flexDirection: "row", gap: 8, alignSelf: "stretch", justifyContent: "center" }}
        >
          <Button
            kind={tab === "fixed" ? "primary" : "quiet"}
            label={t("myQr.tab.fixed")}
            onPress={() => setTab("fixed")}
          />
          <Button
            kind={tab === "kiosk" ? "primary" : "quiet"}
            label={t("myQr.kioskTab")}
            onPress={() => setTab("kiosk")}
          />
        </View>
        {tab === "fixed" ? <FixedCode /> : <KioskCode />}
      </ScrollView>
    </Screen>
  );
}

/** The fixed My QR: cached in SecureStore, so it works offline (ADR-137). */
function FixedCode() {
  const { t, language } = useI18n();
  const { state } = usePlayer();
  const me = state.status === "signed_in" ? state.me?.id : undefined;
  const { width } = useWindowDimensions();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Another account's code never shows, even if dropping it at sign-out failed.
    const stored = await store.read();
    const cached =
      stored !== null && (me === undefined || playerOfCode(stored) === me) ? stored : null;
    if (cached !== null) {
      setToken(cached);
    }
    const answer = await fetchMyQr(api.session);
    if (answer.kind === "code") {
      setToken(answer.token);
      await store.write(answer.token);
    } else if (cached === null) {
      setToken(null);
    }
  }, [me]);
  useEffect(() => {
    void load();
  }, [load]);

  const reset = async () => {
    setBusy(true);
    const answer = await resetMyQr(api.session, randomUuid());
    setBusy(false);
    setConfirming(false);
    if (answer.kind === "code") {
      setToken(answer.token);
      await store.write(answer.token);
      setNote(t("myQr.resetDone"));
    } else if (answer.kind === "refused") {
      setNote(answer.message === null ? t("join.network") : answer.message[language]);
    } else {
      setNote(t("join.network"));
    }
  };

  return (
    <>
      {token === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
      {token === null ? <AppText accessibilityRole="alert">{t("myQr.offline")}</AppText> : null}
      {typeof token === "string" ? (
        <View style={{ padding: 12, backgroundColor: "#ffffff", borderRadius: 12 }}>
          <QrCode text={token} size={Math.min(width - 72, 320)} label={t("myQr.title")} />
        </View>
      ) : null}
      <AppText>{t("myQr.hint")}</AppText>
      <DeskItems />
      {note === null ? null : <AppText accessibilityRole="alert">{note}</AppText>}
      {confirming ? (
        <View style={{ gap: 8, alignSelf: "stretch" }}>
          <AppText variant="title">{t("myQr.resetTitle")}</AppText>
          <AppText>{t("myQr.resetBody")}</AppText>
          <Button label={t("myQr.reset")} disabled={busy} onPress={() => void reset()} />
          <Button kind="quiet" label={t("common.cancel")} onPress={() => setConfirming(false)} />
        </View>
      ) : (
        <Button kind="quiet" label={t("myQr.reset")} onPress={() => setConfirming(true)} />
      )}
    </>
  );
}
