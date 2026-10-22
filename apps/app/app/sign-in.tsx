import {
  AVATARS,
  JOIN_LINK_HOSTS,
  MESSAGES,
  type Avatar,
  type MessageKey,
  type Theme,
} from "@questify/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { consentVersions } from "#src/config/remote.ts";
import {
  isolatedLtr,
  requestCode,
  resendCode,
  signUp,
  verifyCode,
  westernDigits,
  type SignInDeps,
} from "#src/auth/sign-in-api.ts";
import {
  signInStep,
  startSignIn,
  type PendingJoin,
  type SignInState,
} from "#src/auth/sign-in-flow.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { pendingInviteOf } from "#src/operator/station.ts";
import { joinEvent } from "#src/join/join-api.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** Each avatar's name in the message table. */
const AVATAR_NAMES: Readonly<Record<Avatar, MessageKey>> = {
  falcon: "avatar.falcon",
  fox: "avatar.fox",
  camel: "avatar.camel",
  owl: "avatar.owl",
  lantern: "avatar.lantern",
  "explorer-hat": "avatar.explorerHat",
};

const deps: SignInDeps = { client: api.client, session: api.session, now: Date.now };

const SAVE_FAILED = MESSAGES["signIn.saveFailed"];

/** The join the person tapped before signing in, from the route (memory only, ADR-089). */
function pendingFrom(
  params: Record<string, string | string[] | undefined>,
): PendingJoin | undefined {
  const { code, via, card } = params;
  const ways = ["code", "qr", "link", "public_list"] as const;
  return typeof code === "string" &&
    typeof card === "string" &&
    ways.includes(via as (typeof ways)[number])
    ? { code, via: via as PendingJoin["via"], cardVersion: card }
    : undefined;
}

/** A sign-in step that saves the tokens may fail at the secure store: that is a problem to show, not a sign-in. */
async function safely<T>(work: () => Promise<T>, fallback: (error: unknown) => T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return fallback(error);
  }
}

function useSecondsUntil(at: number | null): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return at === null ? 0 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function ConsentStep({ state, dispatch, close }: StepProps<"consent">) {
  const { t, language } = useI18n();
  const open = (id: string) =>
    void Linking.openURL(`https://${JOIN_LINK_HOSTS[0]}/${language}/legal/${id}`);
  return (
    <>
      <AppText variant="title">{t("signIn.consentTitle")}</AppText>
      <AppText>{t("signIn.consentBody")}</AppText>
      <Button kind="quiet" label={t("signIn.terms")} onPress={() => open("terms_of_use")} />
      <Button kind="quiet" label={t("signIn.privacy")} onPress={() => open("privacy_policy")} />
      <Problem problem={state.problem} />
      {state.versions === undefined ? <AppText muted>{t("signIn.versionsMissing")}</AppText> : null}
      <Button
        label={t("signIn.accept")}
        disabled={state.versions === undefined}
        onPress={() => dispatch({ type: "accepted" })}
      />
      <Button kind="quiet" label={t("signIn.notNow")} onPress={close} />
    </>
  );
}

function ContactStep({ state, dispatch }: StepProps<"contact">) {
  const { t, language } = useI18n();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    dispatch(
      await requestCode(deps, {
        channel: state.channel,
        value: value.trim(),
        lang: language,
        versions: state.versions,
        ...(state.previous === undefined ? {} : { previous: state.previous }),
      }),
    );
    setBusy(false);
  };
  const phone = state.channel === "phone";
  return (
    <>
      <Field
        label={t(phone ? "signIn.phone" : "signIn.email")}
        value={value}
        onChangeText={setValue}
        keyboardType={phone ? "phone-pad" : "email-address"}
        autoComplete={phone ? "tel" : "email"}
        autoCapitalize="none"
        style={{ writingDirection: "ltr", textAlign: "left" }}
      />
      <Problem problem={state.problem} />
      <Button
        label={t("signIn.sendCode")}
        disabled={busy || value.trim() === ""}
        onPress={() => void send()}
      />
      <Button
        kind="quiet"
        label={t(phone ? "signIn.useEmail" : "signIn.usePhone")}
        onPress={() => dispatch({ type: "channel_chosen", channel: phone ? "email" : "phone" })}
      />
    </>
  );
}

function CodeStep({ state, dispatch }: StepProps<"code">) {
  const { t, language } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const resendIn = useSecondsUntil(state.resendAt);
  const emailIn = useSecondsUntil(state.emailOfferAt);
  const verify = async () => {
    setBusy(true);
    dispatch(
      await safely(
        () => verifyCode(deps, { challengeToken: state.challengeToken, code: westernDigits(code) }),
        () => ({ type: "refused", problem: SAVE_FAILED }) as const,
      ),
    );
    setBusy(false);
  };
  return (
    <>
      <AppText variant="title">{t("signIn.codeTitle")}</AppText>
      <AppText>{t("signIn.codeSentTo", { contact: isolatedLtr(state.contact) })}</AppText>
      <Field
        label={t("signIn.code")}
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={6}
        style={{ writingDirection: "ltr", textAlign: "left" }}
      />
      {state.attemptsLeft === null ? null : (
        <AppText muted>{t("signIn.attemptsLeft", { count: state.attemptsLeft })}</AppText>
      )}
      <Problem problem={state.problem} />
      <Button
        label={t("signIn.verify")}
        disabled={busy || westernDigits(code).length < 6}
        onPress={() => void verify()}
      />
      <Button
        kind="quiet"
        label={resendIn > 0 ? t("signIn.resendIn", { seconds: resendIn }) : t("signIn.resend")}
        disabled={resendIn > 0}
        onPress={() =>
          void resendCode(deps, { challengeToken: state.challengeToken, lang: language }).then(
            dispatch,
          )
        }
      />
      {state.emailOfferAt !== null && emailIn === 0 ? (
        <Button
          kind="quiet"
          label={t("signIn.emailOffer")}
          onPress={() => dispatch({ type: "channel_chosen", channel: "email" })}
        />
      ) : null}
    </>
  );
}

function ProfileStep({ state, dispatch }: StepProps<"profile">) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [username, setUsername] = useState("");
  const [year, setYear] = useState("");
  const [avatar, setAvatar] = useState<Avatar>(AVATARS[0]);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    dispatch(
      await safely(
        () =>
          signUp(deps, {
            signupToken: state.signupToken,
            username: username.trim(),
            birthYear: Number(westernDigits(year)),
            avatar,
          }),
        () => ({ type: "refused", problem: SAVE_FAILED }) as const,
      ),
    );
    setBusy(false);
  };
  return (
    <>
      <AppText variant="title">{t("signIn.profileTitle")}</AppText>
      <Field
        label={t("signIn.username")}
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
      />
      <Field
        label={t("signIn.birthYear")}
        value={year}
        onChangeText={setYear}
        keyboardType="number-pad"
        maxLength={4}
      />
      <AppText variant="label">{t("signIn.avatar")}</AppText>
      <View style={styles.avatars}>
        {AVATARS.map((choice) => (
          <Pressable
            key={choice}
            accessibilityRole="radio"
            accessibilityState={{ selected: choice === avatar }}
            onPress={() => setAvatar(choice)}
            style={[styles.avatar, choice === avatar && styles.chosen]}
          >
            <AppText variant="label">{t(AVATAR_NAMES[choice])}</AppText>
          </Pressable>
        ))}
      </View>
      <Problem problem={state.problem} />
      <Button
        label={t("signIn.create")}
        disabled={busy || username.trim() === "" || !/^[0-9]{4}$/.test(westernDigits(year))}
        onPress={() => void create()}
      />
    </>
  );
}

type StepProps<S extends SignInState["step"]> = Readonly<{
  state: Extract<SignInState, { step: S }>;
  dispatch: (event: Parameters<typeof signInStep>[1]) => void;
  close: () => void;
}>;

/**
 * Sign-in (FR-106 to FR-110, FR-1705): consent, a phone or email, the code, and for a new player the profile step. A
 * join tapped before signing in waits in memory and goes through once, after success; closing joins nothing.
 */
export default function SignInScreen() {
  const { t } = useI18n();
  const { reload } = usePlayer();
  const params = useLocalSearchParams();
  const [state, dispatch] = useReducer(signInStep, pendingFrom(params), startSignIn);
  // An operator invite opened before sign-in opens again after it (FR-903).
  const invite = pendingInviteOf(params);
  const finished = useRef(false);

  useEffect(() => {
    void consentVersions({ client: api.client, store: keyValueStore }).then((versions) =>
      dispatch({ type: "versions_loaded", versions }),
    );
  }, []);

  useEffect(() => {
    if (state.step !== "done" || finished.current) {
      return;
    }
    finished.current = true;
    void reload().then(async () => {
      if (state.join === undefined) {
        router.replace(invite === undefined ? "/" : `/operator-invite/${invite}`);
        return;
      }
      const outcome = await joinEvent(api.session, state.join);
      // The card screen shows how it went.
      const shown =
        outcome.kind === "joined"
          ? outcome.alreadyMember
            ? "already"
            : outcome.status
          : outcome.kind === "stale" || outcome.kind === "network"
            ? outcome.kind
            : undefined;
      // A refusal (ended, way turned off, not allowed) is shown at once, in the API's own words.
      const problem = outcome.kind === "refused" ? outcome.problem : null;
      router.replace({
        pathname: "/join/[code]",
        params: {
          code: state.join.code,
          via: state.join.via,
          ...(shown === undefined ? {} : { outcome: shown }),
          ...(problem === null ? {} : { problemAr: problem.ar, problemEn: problem.en }),
        },
      });
    });
  }, [state, reload, invite]);

  const close = () => {
    dispatch({ type: "closed" });
    // Opened from a link at a cold start, there may be nothing behind sign-in.
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  };

  return (
    <Screen title={t("signIn.start")}>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        {state.step === "consent" ? (
          <ConsentStep state={state} dispatch={dispatch} close={close} />
        ) : null}
        {state.step === "contact" ? (
          <ContactStep state={state} dispatch={dispatch} close={close} />
        ) : null}
        {state.step === "code" ? (
          <CodeStep state={state} dispatch={dispatch} close={close} />
        ) : null}
        {state.step === "profile" ? (
          <ProfileStep state={state} dispatch={dispatch} close={close} />
        ) : null}
        {state.step === "consent" ? null : (
          <Button kind="quiet" label={t("signIn.close")} onPress={close} />
        )}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  avatars: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: theme.spacing.sm },
  avatar: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
  },
  chosen: { borderColor: theme.colors.primaryAction },
});
