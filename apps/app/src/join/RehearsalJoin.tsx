import type { LocalizedText } from "@questify/shared";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { RehearsalStrip } from "#src/components/RehearsalStrip.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { CardReceives } from "#src/join/CardReceives.tsx";
import {
  fetchRehearsal,
  joinRehearsal,
  type RehearsalCardAnswer,
} from "#src/join/rehearsal-api.ts";

/**
 * Joining a rehearsal (FR-1721, T-211): a team member who typed the event's rehearsal code sees the event, the join
 * card and the strip, then joins as a rehearsal account. Signed out: sign in first, then type the code again (the
 * sign-in's pending join is for join codes only).
 */
export function RehearsalJoin({ code }: Readonly<{ code: string }>) {
  const { t, language } = useI18n();
  const { state: player } = usePlayer();
  const [answer, setAnswer] = useState<RehearsalCardAnswer | undefined>(undefined);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setAnswer(await fetchRehearsal(api.session, code));
  }, [code]);
  useEffect(() => {
    if (player.status === "signed_in") {
      void load();
    }
  }, [load, player.status]);

  if (player.status === "signed_out") {
    return (
      <Screen title={t("rehearsal.joinTitle")}>
        <AppText>{t("rehearsal.signInFirst")}</AppText>
        <Button label={t("signIn.start")} onPress={() => router.push("/sign-in")} />
      </Screen>
    );
  }
  if (answer === undefined || answer.kind === "signed_out") {
    return (
      <Screen title={t("rehearsal.joinTitle")}>
        <AppText muted>{t("common.loading")}</AppText>
      </Screen>
    );
  }
  if (answer.kind !== "card") {
    return (
      <Screen title={t("rehearsal.joinTitle")}>
        <AppText accessibilityRole="alert">
          {t(
            answer.kind === "not_found"
              ? "rehearsal.notFound"
              : answer.kind === "throttled"
                ? "join.throttled"
                : "join.network",
          )}
        </AppText>
        {answer.kind === "not_found" ? null : (
          <Button label={t("common.retry")} onPress={() => void load()} />
        )}
      </Screen>
    );
  }

  const tapJoin = async () => {
    setBusy(true);
    setProblem(null);
    const joined = await joinRehearsal(api.session, code, answer.card.version);
    setBusy(false);
    if (joined.kind === "joined") {
      router.replace(`/event/${joined.eventId}`);
    } else if (joined.kind === "stale") {
      setAnswer({ ...answer, card: joined.card });
    } else if (joined.kind === "refused") {
      setProblem(joined.problem);
    } else if (joined.kind === "signed_out") {
      router.push("/sign-in");
    } else {
      setProblem({ ar: t("join.network"), en: t("join.network") });
    }
  };

  return (
    <Screen title={textIn(answer.event.name, language)} header={<RehearsalStrip shown />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <AppText variant="title">{t("rehearsal.joinTitle")}</AppText>
        <AppText>{t("rehearsal.joinIntro")}</AppText>
        <CardReceives card={answer.card} />
        <Problem problem={problem} />
        <Button label={t("rehearsal.join")} disabled={busy} onPress={() => void tapJoin()} />
      </ScrollView>
    </Screen>
  );
}
