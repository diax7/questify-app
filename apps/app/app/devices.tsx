import { formatLocalDate, type Theme } from "@questify/shared";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Image, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import {
  endDevices,
  loadDevices,
  requestReauthCode,
  verifyReauthCode,
  type DevicesDeps,
} from "#src/account/devices-api.ts";
import {
  codeChannels,
  daysSince,
  fallbackNameKey,
  devicesStep,
  localDay,
  startDevices,
  type Device,
  type DevicesEvent,
  type DevicesState,
} from "#src/account/devices-flow.ts";
import { isolatedLtr, westernDigits } from "#src/auth/sign-in-api.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { daysLabel } from "#src/streaks/days.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

const deps: DevicesDeps = { session: api.session, now: Date.now, newKey: randomUuid };

// No phone icon exists in the set yet (docs/FOLLOWUPS.md): the 3D padlock stands for a signed-in device.
const ICON = require("#assets/icons/padlock.webp");

const LTR = { writingDirection: "ltr", textAlign: "left" } as const;

type Dispatch = (event: DevicesEvent) => void;

/** A device's shown name: its model, else its platform's. */
function useShownName(): (device: Device) => string {
  const { t } = useI18n();
  return (device) => device.model ?? t(fallbackNameKey(device));
}

/** "Last used today / yesterday / 3 days ago / 2 Nov 2026": a day, never a time. */
function useLastUsed(): (device: Device) => string {
  const { t, language } = useI18n();
  return (device) => {
    const used = new Date(device.lastUsedAt);
    const days = daysSince(used, new Date());
    if (days === 0) return t("myDevices.usedToday");
    if (days === 1) return t("myDevices.usedYesterday");
    if (days < 7) return t("myDevices.usedDaysAgo", { days: daysLabel(t, days, language) });
    return t("myDevices.usedOn", { date: formatLocalDate(localDay(used), language) });
  };
}

function DeviceCard({
  device,
  onSignOut,
}: Readonly<{ device: Device; onSignOut: (() => void) | null }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const name = useShownName();
  const lastUsed = useLastUsed();
  return (
    <View style={styles.card}>
      <Image
        source={ICON}
        style={styles.icon}
        accessible={false}
        accessibilityIgnoresInvertColors
      />
      <View style={styles.text}>
        <AppText variant="label">{name(device)}</AppText>
        <AppText muted>
          {t("myDevices.signedIn", {
            date: formatLocalDate(localDay(new Date(device.signedInAt)), language),
          })}
        </AppText>
        <AppText muted>{lastUsed(device)}</AppText>
      </View>
      {device.current ? (
        <View style={styles.tag}>
          <AppText variant="label" style={styles.tagText}>
            {t("myDevices.thisDevice")}
          </AppText>
        </View>
      ) : null}
      {onSignOut === null ? null : (
        <Button kind="quiet" label={t("myDevices.signOut")} onPress={onSignOut} />
      )}
    </View>
  );
}

/** One tap at a time: a second tap can land before the disabled button renders. */
function useOnce(dispatch: Dispatch) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const run = async (work: () => Promise<DevicesEvent>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    dispatch(await work());
    inFlight.current = false;
    setBusy(false);
  };
  return { busy, run };
}

function ConfirmStep({
  state,
  dispatch,
}: Readonly<{ state: Extract<DevicesState, { step: "confirm" }>; dispatch: Dispatch }>) {
  const { t } = useI18n();
  const { busy, run } = useOnce(dispatch);
  const one = state.target.kind === "one";
  return (
    <>
      <AppText variant="title">
        {state.target.kind === "one"
          ? t("myDevices.confirmOne", { device: state.target.name })
          : t("myDevices.confirmOthers")}
      </AppText>
      {one ? <AppText>{t("myDevices.confirmOneBody")}</AppText> : null}
      <Problem problem={state.problem} />
      <Button
        label={t(one ? "myDevices.signOut" : "myDevices.afterYes")}
        disabled={busy}
        onPress={() => void run(() => endDevices(deps, state.target))}
      />
      <Button
        kind="quiet"
        label={t("myDevices.cancel")}
        onPress={() => dispatch({ type: "cancel" })}
      />
    </>
  );
}

function ReauthStep({
  state,
  dispatch,
}: Readonly<{ state: Extract<DevicesState, { step: "reauth" }>; dispatch: Dispatch }>) {
  const { t, language } = useI18n();
  const { state: player } = usePlayer();
  const { busy, run } = useOnce(dispatch);
  const [code, setCode] = useState("");
  const identifiers =
    player.status === "signed_in" && player.me !== undefined
      ? player.me.identifiers
      : { phone: null, email: null };
  const channels = codeChannels(identifiers);
  const sent = state.sent;
  return (
    <>
      <AppText variant="title">{t("myDevices.reauthTitle")}</AppText>
      {sent === null ? (
        <>
          <AppText>{t("myDevices.reauthBody")}</AppText>
          {channels.map((channel) => (
            <Button
              key={channel}
              kind={channel === channels[0] ? "primary" : "quiet"}
              label={t(channel === "phone" ? "myDevices.sendToPhone" : "myDevices.sendToEmail")}
              disabled={busy}
              onPress={() => void run(() => requestReauthCode(deps, { channel, lang: language }))}
            />
          ))}
        </>
      ) : (
        <>
          <AppText>{t("myDevices.codeSentTo", { sentTo: isolatedLtr(sent.sentTo) })}</AppText>
          <Field
            label={t("signIn.code")}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={6}
            style={LTR}
          />
          <AppText muted>{t("signIn.codeNeverShare")}</AppText>
          {state.attemptsLeft === null ? null : (
            <AppText muted>{t("signIn.attemptsLeft", { count: state.attemptsLeft })}</AppText>
          )}
          <Button
            label={t("signIn.verify")}
            disabled={busy || westernDigits(code).length < 6}
            onPress={() =>
              void run(async () => {
                const answer = await verifyReauthCode(deps, {
                  challengeToken: sent.challengeToken,
                  code: westernDigits(code),
                });
                if (answer.type !== "confirmed") return answer;
                // Fresh now: the end is tried again at once, as the player asked for it.
                dispatch(answer);
                return endDevices(deps, state.target);
              })
            }
          />
        </>
      )}
      <Problem problem={state.problem} />
      <Button
        kind="quiet"
        label={t("myDevices.cancel")}
        onPress={() => dispatch({ type: "cancel" })}
      />
    </>
  );
}

function ListStep({
  state,
  dispatch,
}: Readonly<{ state: Extract<DevicesState, { step: "list" }>; dispatch: Dispatch }>) {
  const { t } = useI18n();
  const name = useShownName();
  const others = state.devices.filter((device) => !device.current);
  return (
    <>
      {state.notice === null ? null : (
        <AppText accessibilityRole="alert">{t(state.notice)}</AppText>
      )}
      {state.devices.map((device) => (
        <DeviceCard
          key={device.id}
          device={device}
          onSignOut={
            device.current
              ? null
              : () =>
                  dispatch({
                    type: "ask",
                    target: { kind: "one", id: device.id, name: name(device) },
                  })
          }
        />
      ))}
      {others.length === 0 ? (
        <AppText muted>{t("myDevices.onlyThis")}</AppText>
      ) : (
        <Button
          label={t("myDevices.signOutOthers")}
          onPress={() => dispatch({ type: "ask", target: { kind: "others" } })}
        />
      )}
      <Problem problem={state.problem} />
    </>
  );
}

/**
 * Settings → My account → Signed-in devices (T-810c, FR-140, ASVS V7.5.2): every phone where the account is signed
 * in, this one first; sign out of another or of all others, after a fresh code when this phone's sign-in is older than
 * 10 minutes. This phone signs out from the profile as before.
 */
export default function DevicesScreen() {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(devicesStep, startDevices);
  const load = useCallback(async () => dispatch(await loadDevices(deps)), []);

  useEffect(() => {
    if (state.step === "loading") void load();
  }, [state.step, load]);

  return (
    <Screen title={t("myDevices.title")}>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        {state.step === "failed" ? (
          <>
            <Problem problem={state.problem} />
            <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
        {state.step === "list" ? <ListStep state={state} dispatch={dispatch} /> : null}
        {state.step === "confirm" ? <ConfirmStep state={state} dispatch={dispatch} /> : null}
        {state.step === "reauth" ? <ReauthStep state={state} dispatch={dispatch} /> : null}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  icon: { width: 40, height: 40 },
  text: { flex: 1, gap: theme.spacing.xs },
  tag: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.tierGold,
  },
  tagText: { color: theme.colors.text },
});
