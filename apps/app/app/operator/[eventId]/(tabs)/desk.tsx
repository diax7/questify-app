import { DEFAULT_TERMS, formatNumber, termFor, type Theme } from "@questify/shared";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { PermissionCard, useCameraActive } from "#src/components/Camera.tsx";
import { Button, Field } from "#src/components/Controls.tsx";
import { RehearsalStrip } from "#src/components/RehearsalStrip.tsx";
import { isRehearsalStatus } from "#src/event/rehearsal.ts";
import { Screen } from "#src/components/Screen.tsx";
import { DeskLine } from "#src/event/DeskLine.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import {
  OFFER_POLL_MS,
  actionLabel,
  deskStateKey,
  itemAction,
  offerOutcome,
  pickupMinutesLeft,
  type DeskInfo,
  type DeskItem,
  type Found,
} from "#src/operator/desk.ts";
import {
  cancelAtDesk,
  fetchDesk,
  findAtDesk,
  handOverAtDesk,
  lookUpAtDesk,
  pollOffer,
} from "#src/operator/operator-api.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { isPlayerCode } from "#src/operator/station.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";
import { PracticeLocked } from "#src/operator/Practice.tsx";

/** What happened to a row on this desk since the scan. */
type Done = "handed_over" | "cancelled" | "ended" | "lapsed";

/** One waiting item: its name, what the desk may do now, and Cancel (FR-925, FR-509, FR-513). */
function ItemRow({
  item,
  desk,
  found,
  done,
  busy,
  onHandOver,
  onCancel,
}: Readonly<{
  item: DeskItem;
  desk: DeskInfo;
  found: Found;
  done: Done | undefined;
  busy: boolean;
  onHandOver: () => void;
  onCancel: () => void;
}>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const action = itemAction(item, desk, found, Date.now());
  const player = found.player.username;
  const minutes = action === "held" ? pickupMinutesLeft(item, Date.now()) : null;
  return (
    <View style={styles.card}>
      <AppText variant="label">{textIn(item.name, language)}</AppText>
      {item.rank === null ? null : (
        <AppText muted>{t("win.rankPrize", { rank: formatNumber(item.rank, language) })}</AppText>
      )}
      {item.questReward ? <AppText muted>{t("win.questReward")}</AppText> : null}
      {item.kind === "experience" ? <AppText muted>{t("operator.desk.experience")}</AppText> : null}
      {done === "handed_over" ? (
        <AppText accessibilityRole="alert">
          {t(item.kind === "experience" ? "operator.desk.doneExperience" : "operator.desk.done")}
        </AppText>
      ) : null}
      {done === "cancelled" ? <AppText>{t("operator.desk.cancelled")}</AppText> : null}
      {done === "ended" ? <AppText>{t("operator.desk.ended")}</AppText> : null}
      {done === undefined || done === "lapsed" ? (
        <>
          {done === "lapsed" ? <AppText>{t("operator.desk.notAccepted")}</AppText> : null}
          {action === "held" ? (
            <AppText accessibilityRole="alert">{t("operator.desk.held")}</AppText>
          ) : null}
          {minutes === null ? null : (
            <AppText muted>{t("operator.desk.pickupLeft", { minutes: String(minutes) })}</AppText>
          )}
          {action === "not_ready" ? (
            <AppText>{t("operator.desk.notReady", { player })}</AppText>
          ) : null}
          {action === "waiting" ? (
            <AppText accessibilityLiveRegion="polite">
              {t("operator.desk.waitingAccept", { player })}
            </AppText>
          ) : null}
          {action === "hand_over" || action === "offer" ? (
            <Button label={t(actionLabel(item, action))} disabled={busy} onPress={onHandOver} />
          ) : null}
          {action === "blocked" ? null : (
            <Button
              kind="quiet"
              label={t("operator.desk.cancel")}
              disabled={busy}
              onPress={onCancel}
            />
          )}
        </>
      ) : null}
    </View>
  );
}

/** The scanned player and their waiting items; nothing here ever pays points (FR-926). */
function PlayerCard({
  found,
  desk,
  done,
  busy,
  onHandOver,
  onCancel,
  onRefresh,
  onNext,
}: Readonly<{
  found: Found;
  desk: DeskInfo;
  done: Readonly<Record<string, Done>>;
  busy: boolean;
  onHandOver: (item: DeskItem) => void;
  onCancel: (item: DeskItem) => void;
  onRefresh: () => void;
  onNext: () => void;
}>) {
  const { t } = useI18n();
  const player = found.player.username;
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="title">{player}</AppText>
      {found.active ? null : (
        <AppText accessibilityRole="alert">{t("operator.desk.inactive")}</AppText>
      )}
      {found.active && found.hold === "paused" ? (
        <AppText accessibilityRole="alert">{t("operator.desk.paused", { player })}</AppText>
      ) : null}
      {found.items.length === 0 ? (
        <AppText>{t("operator.desk.nothing", { player })}</AppText>
      ) : (
        <AppText muted>{t("operator.desk.waiting", { count: String(found.items.length) })}</AppText>
      )}
      {found.items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          desk={desk}
          found={found}
          done={done[item.id]}
          busy={busy}
          onHandOver={() => onHandOver(item)}
          onCancel={() => onCancel(item)}
        />
      ))}
      {found.items.length === 0 ? null : (
        <Button kind="quiet" label={t("common.retry")} disabled={busy} onPress={onRefresh} />
      )}
      <Button label={t("operator.desk.scanNext")} onPress={onNext} />
    </View>
  );
}

/** The desk's camera: the player's My QR, read once until the desk scans next. */
function DeskCamera({ onCode }: Readonly<{ onCode: (code: string) => void }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [permission, requestPermission] = useCameraPermissions();
  const active = useCameraActive();
  const [failed, setFailed] = useState(false);
  if (permission === null) {
    return <AppText muted>{t("common.loading")}</AppText>;
  }
  if (!permission.granted) {
    return (
      <PermissionCard
        canAskAgain={permission.canAskAgain}
        onAllow={() => void requestPermission()}
      />
    );
  }
  if (failed) {
    return <AppText accessibilityRole="alert">{t("scanner.cameraFailed")}</AppText>;
  }
  return active ? (
    <>
      <AppText muted>{t("operator.desk.scanHint")}</AppText>
      <View style={styles.camera}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => onCode(data.trim())}
          onMountError={() => setFailed(true)}
        />
      </View>
    </>
  ) : null;
}

/** FR-1848: find by exact username or mobile number when My QR will not scan; the result reads like a scan's. */
function DeskFind({ busy, onFind }: Readonly<{ busy: boolean; onFind: (query: string) => void }>) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const send = () => {
    if (query.trim() !== "") {
      onFind(query.trim());
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <Field
        label={t("operator.desk.findLink")}
        placeholder={t("operator.desk.findHint")}
        autoCapitalize="none"
        autoCorrect={false}
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={send}
      />
      <Button
        kind="quiet"
        label={t("operator.desk.find")}
        disabled={busy || query.trim() === ""}
        onPress={send}
      />
    </View>
  );
}

type Failure = Readonly<{ kind: string; message?: { ar: string; en: string } | null }>;

/** Where a refused or failed call goes: out of operator mode, back to sign-in, or a line on the screen. */
function useOutcome() {
  const { t, language } = useI18n();
  const { removed } = useOperator();
  const [problem, setProblem] = useState<string | null>(null);
  const settle = useCallback(
    (answer: Failure) => {
      if (answer.kind === "removed") {
        removed();
      } else if (answer.kind === "signed_out") {
        router.replace("/home");
      } else {
        const own = answer.kind === "refused" ? answer.message?.[language] : undefined;
        setProblem(own ?? t("join.network"));
      }
    },
    [language, removed, t],
  );
  return { problem, setProblem, settle };
}

type Source = Readonly<{ kind: "code" | "find"; value: string }>;

/**
 * Who the desk is looking at, from My QR or a find by name or phone (FR-925, FR-1848): one read at a time, Retry
 * reads the same source again, and Scan next forgets it.
 */
function useShownPlayer({
  eventId,
  setFound,
  setProblem,
  settle,
  loadDesk,
}: Readonly<{
  eventId: string;
  setFound: (found: Found) => void;
  setProblem: (problem: string | null) => void;
  settle: (answer: Failure) => void;
  loadDesk: () => Promise<void>;
}>) {
  const { t } = useI18n();
  const source = useRef<Source | null>(null);
  const reading = useRef(false);
  const show = async (from: Source) => {
    reading.current = true;
    setProblem(null);
    const answer =
      from.kind === "code"
        ? await lookUpAtDesk(api.session, eventId, from.value)
        : await findAtDesk(api.session, eventId, from.value);
    // A player on screen keeps the camera's reads ignored until Scan next.
    if (answer.kind !== "lookup") {
      reading.current = false;
      settle(answer);
    } else if (answer.lookup.kind === "refused") {
      reading.current = false;
      setProblem(t(answer.lookup.reason));
    } else {
      source.current = from;
      setFound(answer.lookup);
      void loadDesk();
    }
  };
  return {
    scanned: (text: string) => {
      if (reading.current) {
        return;
      }
      if (isPlayerCode(text)) {
        void show({ kind: "code", value: text });
      } else {
        setProblem(t("operator.red.invalidCode"));
      }
    },
    find: (query: string) => void show({ kind: "find", value: query }),
    refresh: () => (source.current === null ? undefined : void show(source.current)),
    forget: () => {
      source.current = null;
      reading.current = false;
    },
  };
}

type Rows = Readonly<{
  setFound: (change: (current: Found | null) => Found | null) => void;
  setDone: (
    change: (current: Readonly<Record<string, Done>>) => Readonly<Record<string, Done>>,
  ) => void;
  settle: (answer: Failure) => void;
  clearProblem: () => void;
}>;

/**
 * Handed over, Hand over and Cancel on the scanned player's rows. One key per row and action until the server answers,
 * so a lost reply is retried, never doubled. After an offer the desk asks every 2 seconds until the player accepts,
 * the offer lapses, or the reservation ends; `stop` ends every wait (the next scan, leaving the tab).
 */
function useRowActions({ setFound, setDone, settle, clearProblem }: Rows) {
  const [busy, setBusy] = useState(false);
  const keys = useRef(new Map<string, string>());
  // Each scan is a generation: a wait from an earlier one stops at its next step.
  const generation = useRef(0);
  const stop = useCallback(() => {
    generation.current += 1;
  }, []);
  useEffect(() => stop, [stop]);
  const keyFor = (name: string) => {
    const key = keys.current.get(name) ?? randomUuid();
    keys.current.set(name, key);
    return key;
  };
  const mark = (id: string, done: Done) => setDone((current) => ({ ...current, [id]: done }));

  const waitForAccept = async (item: DeskItem) => {
    const started = generation.current;
    let outcome: ReturnType<typeof offerOutcome> = "waiting";
    while (outcome === "waiting") {
      await new Promise((resolve) => setTimeout(resolve, OFFER_POLL_MS));
      if (generation.current !== started) {
        return;
      }
      const poll = await pollOffer(api.session, item.id);
      if (generation.current !== started) {
        return;
      }
      if (poll.kind !== "poll") {
        settle(poll);
        return;
      }
      outcome = offerOutcome(poll, Date.now());
    }
    mark(
      item.id,
      outcome === "accepted" ? "handed_over" : outcome === "ended" ? "ended" : "lapsed",
    );
  };

  const handOver = async (item: DeskItem) => {
    setBusy(true);
    clearProblem();
    const name = `hand:${item.id}`;
    const answer = await handOverAtDesk(api.session, item.id, keyFor(name));
    if (answer.kind !== "network") {
      keys.current.delete(name);
    }
    setBusy(false);
    if (answer.kind === "handed_over") {
      mark(item.id, "handed_over");
      return;
    }
    if (answer.kind !== "offered") {
      settle(answer);
      return;
    }
    setDone(({ [item.id]: _lapsed, ...rest }) => rest);
    setFound((current) =>
      current === null
        ? current
        : {
            ...current,
            items: current.items.map((row) =>
              row.id === item.id ? { ...row, offered: true, offerUntil: answer.offerUntil } : row,
            ),
          },
    );
    await waitForAccept(item);
  };

  const cancel = async (item: DeskItem) => {
    setBusy(true);
    const name = `cancel:${item.id}`;
    const answer = await cancelAtDesk(api.session, item.id, keyFor(name));
    if (answer.kind !== "network") {
      keys.current.delete(name);
    }
    setBusy(false);
    if (answer.kind === "cancelled") {
      mark(item.id, "cancelled");
    } else {
      settle(answer);
    }
  };

  return { busy, handOver, cancel, stop };
}

/**
 * The prize desk (T-206): scan the player's My QR, see what they reserved, hand it over once the player confirmed in
 * their own app (ADR-137: Collect first, or the desk's offer they accept), confirm an experience, or cancel. The desk
 * never awards points (FR-926). A removed operator leaves operator mode at the first refused call (FR-905).
 */
function DeskTab() {
  const { t, language } = useI18n();
  const { eventId, event } = useOperator();
  const { problem, setProblem, settle } = useOutcome();
  const [desk, setDesk] = useState<DeskInfo | undefined>(undefined);
  const [found, setFound] = useState<Found | null>(null);
  const [done, setDone] = useState<Readonly<Record<string, Done>>>({});
  const rows = useRowActions({ setFound, setDone, settle, clearProblem: () => setProblem(null) });
  const canHandOver = event === undefined || event.abilities.includes("hand_over");

  const loadDesk = useCallback(async () => {
    const answer = await fetchDesk(api.session, eventId);
    if (answer.kind === "desk") {
      setDesk(answer.desk);
    } else {
      settle(answer);
    }
  }, [eventId, settle]);
  useEffect(() => {
    void loadDesk();
  }, [loadDesk]);
  const shown = useShownPlayer({ eventId, setFound, setProblem, settle, loadDesk });

  const next = () => {
    rows.stop();
    setFound(null);
    setDone({});
    setProblem(null);
    shown.forget();
  };

  const confirmCancel = (item: DeskItem) =>
    Alert.alert(
      t("operator.desk.cancelTitle"),
      t("operator.desk.cancelBody", {
        player: found?.player.username ?? "",
        currency: termFor(DEFAULT_TERMS.currency, language),
      }),
      [
        { text: t("operator.desk.keep"), style: "cancel" },
        {
          text: t("operator.desk.cancelYes"),
          style: "destructive",
          onPress: () => void rows.cancel(item),
        },
      ],
    );

  return (
    <Screen
      title={t("operator.desk")}
      header={<RehearsalStrip shown={isRehearsalStatus(event?.statusNow)} />}
    >
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        {desk === undefined ? null : (
          <>
            <AppText variant="label">{t(deskStateKey(desk))}</AppText>
            <DeskLine desk={desk} />
          </>
        )}
        {problem === null ? null : <AppText accessibilityRole="alert">{problem}</AppText>}
        {canHandOver ? null : <AppText>{t("operator.desk.abilityOff")}</AppText>}
        {canHandOver && found === null ? (
          <>
            <DeskCamera onCode={shown.scanned} />
            <DeskFind busy={rows.busy} onFind={shown.find} />
          </>
        ) : null}
        {found !== null && desk !== undefined ? (
          <PlayerCard
            found={found}
            desk={desk}
            done={done}
            busy={rows.busy}
            onHandOver={(item) => void rows.handOver(item)}
            onCancel={confirmCancel}
            onRefresh={shown.refresh}
            onNext={next}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  camera: {
    height: 360,
    overflow: "hidden" as const,
    borderRadius: theme.radius.lg,
    borderWidth: 3,
    borderColor: theme.colors.border,
  },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});

/** Locked while practice mode is on (ADR-250): this tool writes real records. */
export default function DeskTabRoute() {
  return (
    <PracticeLocked title="operator.desk" back={false}>
      <DeskTab />
    </PracticeLocked>
  );
}
