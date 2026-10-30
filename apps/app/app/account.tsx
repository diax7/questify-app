import { toWesternDigits } from "@questify/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import {
  requestContactCode,
  verifyContactCode,
  type ContactDeps,
} from "#src/account/contact-api.ts";
import { contactStep, startContact, type ContactState } from "#src/account/contact-flow.ts";
import { isolatedLtr, westernDigits } from "#src/auth/sign-in-api.ts";
import type { Channel } from "#src/auth/sign-in-flow.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

const deps: ContactDeps = { session: api.session, now: Date.now, newKey: randomUuid };

const LTR = { writingDirection: "ltr", textAlign: "left" } as const;

type StepProps<S extends ContactState["step"]> = Readonly<{
  state: Extract<ContactState, { step: S }>;
  dispatch: (event: Parameters<typeof contactStep>[1]) => void;
}>;

function useSecondsUntil(at: number): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function EnterStep({ state, dispatch }: StepProps<"enter">) {
  const { t, language } = useI18n();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const phone = state.channel === "phone";
  const send = async () => {
    setBusy(true);
    dispatch(
      await requestContactCode(deps, {
        channel: state.channel,
        value: value.trim(),
        lang: language,
      }),
    );
    setBusy(false);
  };
  return (
    <>
      <Field
        label={t(phone ? "account.newPhone" : "account.newEmail")}
        value={value}
        onChangeText={setValue}
        keyboardType={phone ? "phone-pad" : "email-address"}
        autoComplete={phone ? "tel" : "email"}
        autoCapitalize="none"
        style={LTR}
      />
      <Problem problem={state.problem} />
      <Button
        label={t("signIn.sendCode")}
        disabled={busy || value.trim() === ""}
        onPress={() => void send()}
      />
    </>
  );
}

function CodeStep({ state, dispatch }: StepProps<"code">) {
  const { t, language } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const resendIn = useSecondsUntil(state.resendAt);
  // A ref, not the state: a second tap can land before the disabled button renders.
  const inFlight = useRef(false);
  const run = async (work: () => ReturnType<typeof verifyContactCode>) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    dispatch(await work());
    inFlight.current = false;
    setBusy(false);
  };
  return (
    <>
      <AppText variant="title">{t("signIn.codeTitle")}</AppText>
      <AppText>
        {t("signIn.codeSentTo", { contact: isolatedLtr(toWesternDigits(state.contact)) })}
      </AppText>
      <Field
        label={t("signIn.code")}
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete={state.channel === "phone" ? "sms-otp" : "one-time-code"}
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
            verifyContactCode(deps, {
              challengeToken: state.challengeToken,
              code: westernDigits(code),
              lang: language,
            }),
          )
        }
      />
      <Button
        kind="quiet"
        label={resendIn > 0 ? t("signIn.resendIn", { seconds: resendIn }) : t("signIn.resend")}
        disabled={busy || resendIn > 0}
        onPress={() =>
          void run(() =>
            requestContactCode(deps, {
              channel: state.channel,
              value: state.contact,
              lang: language,
            }),
          )
        }
      />
    </>
  );
}

const channelOf = (value: unknown): Channel => (value === "phone" ? "phone" : "email");

/**
 * Settings → My account (FR-125, FR-139): change the phone or email on the account, or add the one it lacks. The code
 * goes to the new value; the account changes only when it is entered.
 */
export default function AccountScreen() {
  const { t } = useI18n();
  const { state: player, reload } = usePlayer();
  const { channel } = useLocalSearchParams();
  const [state, dispatch] = useReducer(contactStep, channelOf(channel), startContact);
  const signedIn = player.status === "signed_in";
  const current = signedIn ? player.me?.identifiers[state.channel] : undefined;
  // The title follows the account as it was when the screen opened: after the change, "Change" would mislead.
  const [adding] = useState(current === null);

  useEffect(() => {
    if (state.step === "done") {
      void reload();
    }
  }, [state.step, reload]);

  // A verify whose answer was lost may have changed the account: read it again whenever the screen closes.
  const close = () => {
    void reload();
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/profile");
    }
  };

  const phone = state.channel === "phone";
  const title = adding
    ? t(phone ? "account.addPhone" : "account.addEmail")
    : t(phone ? "account.changePhone" : "account.changeEmail");

  return (
    <Screen title={title}>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        {player.status === "signed_out" ? (
          <AppText accessibilityRole="alert">{t("signIn.sessionEnded")}</AppText>
        ) : null}
        {signedIn && state.step === "enter" ? (
          <EnterStep state={state} dispatch={dispatch} />
        ) : null}
        {signedIn && state.step === "code" ? <CodeStep state={state} dispatch={dispatch} /> : null}
        {state.step === "done" ? (
          <AppText accessibilityRole="alert">
            {t(adding ? "account.added" : "account.changed")}
          </AppText>
        ) : null}
        <Button kind="quiet" label={t("signIn.close")} onPress={close} />
      </ScrollView>
    </Screen>
  );
}
