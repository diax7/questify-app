import { type Language } from "@questify/shared";
import { router } from "expo-router";
import { useReducer, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import {
  confirmDeletion,
  requestDeletionCode,
  verifyDeletionCode,
  type DeletionDeps,
} from "#src/account/deletion-api.ts";
import {
  START,
  canDelete,
  deletionStep,
  type DeletionEvent,
  type DeletionState,
  type PendingPrize,
} from "#src/account/deletion-flow.ts";
import { westernDigits } from "#src/auth/sign-in-api.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

const deps: DeletionDeps = { session: api.session };

const LTR = { writingDirection: "ltr", textAlign: "left" } as const;

type StepProps<S extends DeletionState["step"]> = Readonly<{
  state: Extract<DeletionState, { step: S }>;
  run: (work: () => Promise<DeletionEvent>) => Promise<void>;
  busy: boolean;
}>;

const textIn = (text: PendingPrize["item"], language: Language): string =>
  (language === "ar" ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? "";

/** What is deleted and what is kept (store guideline 5.1.1(v), Google User Data), then the code. */
function AboutStep({ state, run, busy }: StepProps<"about">) {
  const { t, language } = useI18n();
  const { state: player } = usePlayer();
  const hasEmail = player.status === "signed_in" && (player.me?.identifiers.email ?? null) !== null;
  return (
    <>
      <AppText>{t("deletion.intro")}</AppText>
      <AppText variant="label">{t("deletion.removedTitle")}</AppText>
      <AppText>{t("deletion.removed")}</AppText>
      <AppText variant="label">{t("deletion.keptTitle")}</AppText>
      <AppText>{t("deletion.kept")}</AppText>
      <Problem problem={state.problem} />
      <Button
        label={t("deletion.sendCode")}
        disabled={busy}
        onPress={() =>
          void run(() => requestDeletionCode(deps, { channel: "phone", lang: language }))
        }
      />
      {hasEmail ? (
        <Button
          kind="quiet"
          label={t("deletion.useEmail")}
          disabled={busy}
          onPress={() =>
            void run(() => requestDeletionCode(deps, { channel: "email", lang: language }))
          }
        />
      ) : null}
    </>
  );
}

function CodeStep({ state, run, busy }: StepProps<"code">) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  return (
    <>
      <AppText>{t("deletion.codeHint")}</AppText>
      <Field
        label={t("signIn.code")}
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={6}
        style={LTR}
      />
      {state.attemptsLeft === null ? null : (
        <AppText muted>{t("signIn.attemptsLeft", { count: state.attemptsLeft })}</AppText>
      )}
      <Problem problem={state.problem} />
      <Button
        label={t("signIn.verify")}
        disabled={busy || westernDigits(code).length < 6}
        onPress={() =>
          void run(() =>
            verifyDeletionCode(deps, {
              challengeToken: state.challengeToken,
              code: westernDigits(code),
            }),
          )
        }
      />
    </>
  );
}

function PendingPrizes({
  state,
  toggle,
}: Readonly<{ state: Extract<DeletionState, { step: "confirm" }>; toggle: () => void }>) {
  const { t, language } = useI18n();
  if (state.pending.length === 0) {
    return null;
  }
  return (
    <>
      <AppText variant="label">{t("deletion.pendingTitle")}</AppText>
      {state.pending.map((prize) => (
        <AppText key={prize.redemptionId}>
          {`${textIn(prize.item, language)} · ${textIn(prize.event, language)}`}
          {prize.rankPrize ? ` · ${t("deletion.rankPrize")}` : ""}
        </AppText>
      ))}
      <AppText>{t("deletion.pendingBody")}</AppText>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: state.forfeit }}
        onPress={toggle}
        style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
      >
        <AppText>{state.forfeit ? "☑" : "☐"}</AppText>
        <AppText>{t("deletion.forfeit")}</AppText>
      </Pressable>
    </>
  );
}

function ConfirmStep({
  state,
  run,
  busy,
  toggle,
}: StepProps<"confirm"> & Readonly<{ toggle: () => void }>) {
  const { t } = useI18n();
  // FR-126: the last confirmation says what happens; cancelling deletes nothing.
  const ask = () => {
    Alert.alert(t("deletion.confirmTitle"), t("deletion.intro"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("deletion.confirm"),
        style: "destructive",
        onPress: () =>
          void run(() =>
            confirmDeletion(deps, { deletionToken: state.deletionToken, forfeit: state.forfeit }),
          ),
      },
    ]);
  };
  return (
    <>
      <PendingPrizes state={state} toggle={toggle} />
      <Problem problem={state.problem} />
      <Button label={t("deletion.confirm")} disabled={busy || !canDelete(state)} onPress={ask} />
    </>
  );
}

/**
 * Profile → Delete account (FR-126, FR-128, ADR-177): what is deleted and kept, a code to the account's own phone or
 * email, the prizes still waiting, and the final confirmation. Once deleted, the phone forgets the session.
 */
export default function DeleteAccountScreen() {
  const { t } = useI18n();
  const { state: player, signOut } = usePlayer();
  const [state, dispatch] = useReducer(deletionStep, START);
  const [busy, setBusy] = useState(false);
  // A ref, not the state: a second tap can land before the disabled button renders.
  const inFlight = useRef(false);
  const run = async (work: () => Promise<DeletionEvent>) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const event = await work();
    dispatch(event);
    if (event.type === "erased") {
      await signOut();
    }
    inFlight.current = false;
    setBusy(false);
  };
  const toggle = () => {
    if (state.step === "confirm") {
      dispatch({ type: "forfeit", forfeit: !state.forfeit });
    }
  };
  const close = () => {
    if (state.step === "done") {
      router.replace("/home");
    } else if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/profile");
    }
  };
  const signedIn = player.status === "signed_in";

  return (
    <Screen title={t("deletion.title")}>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        {state.step !== "done" && !signedIn ? (
          <AppText accessibilityRole="alert">{t("signIn.sessionEnded")}</AppText>
        ) : null}
        {signedIn && state.step === "about" ? (
          <AboutStep state={state} run={run} busy={busy} />
        ) : null}
        {signedIn && state.step === "code" ? (
          <CodeStep state={state} run={run} busy={busy} />
        ) : null}
        {signedIn && state.step === "confirm" ? (
          <ConfirmStep state={state} run={run} busy={busy} toggle={toggle} />
        ) : null}
        {state.step === "done" ? (
          <View>
            <AppText accessibilityRole="alert">{t("deletion.done")}</AppText>
          </View>
        ) : null}
        <Button kind="quiet" label={t("signIn.close")} onPress={close} disabled={busy} />
      </ScrollView>
    </Screen>
  );
}
