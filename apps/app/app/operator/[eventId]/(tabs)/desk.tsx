import { DEFAULT_TERMS, termFor, type Theme } from "@questify/shared";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { PermissionCard, useCameraActive } from "#src/components/Camera.tsx";
import { Button } from "#src/components/Controls.tsx";
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
  type DeskInfo,
  type DeskItem,
  type Lookup,
} from "#src/operator/desk.ts";
import {
  cancelAtDesk,
  fetchDesk,
  handOverAtDesk,
  lookUpAtDesk,
  pollOffer,
} from "#src/operator/operator-api.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { isPlayerCode } from "#src/operator/station.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Found = Extract<Lookup, { kind: "found" }>;
/** What happened to a row on this desk since the scan. */
type Done = "handed_over" | "cancelled" | "lapsed";

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
  const action = itemAction(item, desk, found.enrollment, Date.now());
  const player = found.player.username;
  return (
    <View style={styles.card}>
      <AppText variant="label">{textIn(item.name, language)}</AppText>
      {item.kind === "experience" ? <AppText muted>{t("operator.desk.experience")}</AppText> : null}
      {done === "handed_over" ? (
        <AppText accessibilityRole="alert">
          {t(item.kind === "experience" ? "operator.desk.doneExperience" : "operator.desk.done")}
        </AppText>
      ) : null}
      {done === "cancelled" ? <AppText>{t("operator.desk.cancelled")}</AppText> : null}
      {done === undefined || done === "lapsed" ? (
        <>
          {done === "lapsed" ? <AppText>{t("operator.desk.notAccepted")}</AppText> : null}
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
      {found.enrollment === "active" ? null : (
        <AppText accessibilityRole="alert">{t("operator.desk.inactive")}</AppText>
      )}
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
 * the offer lapses, or the reservation ends.
 */
function useRowActions({ setFound, setDone, settle, clearProblem }: Rows) {
  const [busy, setBusy] = useState(false);
  const keys = useRef(new Map<string, string>());
  const keyFor = (name: string) => {
    const key = keys.current.get(name) ?? randomUuid();
    keys.current.set(name, key);
    return key;
  };
  const mark = (id: string, done: Done) => setDone((current) => ({ ...current, [id]: done }));

  const waitForAccept = async (item: DeskItem) => {
    let outcome: ReturnType<typeof offerOutcome> = "waiting";
    while (outcome === "waiting") {
      await new Promise((resolve) => setTimeout(resolve, OFFER_POLL_MS));
      const poll = await pollOffer(api.session, item.id);
      if (poll.kind !== "poll") {
        settle(poll);
        return;
      }
      outcome = offerOutcome(poll, Date.now());
    }
    mark(
      item.id,
      outcome === "accepted" ? "handed_over" : outcome === "ended" ? "cancelled" : "lapsed",
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

  return { busy, handOver, cancel };
}

/**
 * The prize desk (T-206): scan the player's My QR, see what they reserved, hand it over once the player confirmed in
 * their own app (ADR-137: Collect first, or the desk's offer they accept), confirm an experience, or cancel. The desk
 * never awards points (FR-926). A removed operator leaves operator mode at the first refused call (FR-905).
 */
export default function DeskTab() {
  const { t, language } = useI18n();
  const { eventId, event } = useOperator();
  const { problem, setProblem, settle } = useOutcome();
  const [desk, setDesk] = useState<DeskInfo | undefined>(undefined);
  const [code, setCode] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [done, setDone] = useState<Readonly<Record<string, Done>>>({});
  const reading = useRef(false);
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

  const look = useCallback(
    async (scanned: string) => {
      setProblem(null);
      const answer = await lookUpAtDesk(api.session, eventId, scanned);
      if (answer.kind !== "lookup" || answer.lookup.kind === "refused") {
        reading.current = false;
        if (answer.kind === "lookup" && answer.lookup.kind === "refused") {
          setProblem(t(answer.lookup.reason));
        } else if (answer.kind !== "lookup") {
          settle(answer);
        }
        return;
      }
      setCode(scanned);
      setFound(answer.lookup);
      void loadDesk();
    },
    [eventId, loadDesk, setProblem, settle, t],
  );

  const scanned = (text: string) => {
    if (reading.current) {
      return;
    }
    if (!isPlayerCode(text)) {
      setProblem(t("operator.red.invalidCode"));
      return;
    }
    reading.current = true;
    void look(text);
  };

  const next = () => {
    setFound(null);
    setCode(null);
    setDone({});
    setProblem(null);
    reading.current = false;
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
    <Screen title={t("operator.desk")}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        {desk === undefined ? null : (
          <>
            <AppText variant="label">{t(deskStateKey(desk))}</AppText>
            <DeskLine desk={desk} />
          </>
        )}
        {problem === null ? null : <AppText accessibilityRole="alert">{problem}</AppText>}
        {canHandOver ? null : <AppText>{t("operator.desk.abilityOff")}</AppText>}
        {canHandOver && found === null ? <DeskCamera onCode={scanned} /> : null}
        {found !== null && desk !== undefined ? (
          <PlayerCard
            found={found}
            desk={desk}
            done={done}
            busy={rows.busy}
            onHandOver={(item) => void rows.handOver(item)}
            onCancel={confirmCancel}
            onRefresh={() => (code === null ? undefined : void look(code))}
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
