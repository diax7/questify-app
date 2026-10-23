import { formatNumber } from "@questify/shared";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { fetchPassport, type PassportView } from "#src/event/passport.ts";
import type { Quest } from "#src/event/quests-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";

/**
 * A passport quest in the quest sheet (T-304b, FR-224): each step with whether it is stamped, how many are needed,
 * and the scanner while the quest is open. Each step's code is printed at its place; the scanner stamps it.
 */
export function PassportEntry({ quest }: Readonly<{ quest: Quest }>) {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const [view, setView] = useState<PassportView | undefined | "failed">(undefined);

  const load = useCallback(async () => {
    setView((await fetchPassport(api.session, quest.id)) ?? "failed");
  }, [quest.id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (view === undefined) {
    return null;
  }
  if (view === "failed") {
    return (
      <>
        <AppText accessibilityRole="alert">{t("play.loadFailed")}</AppText>
        <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
      </>
    );
  }
  const done = view.steps.filter((step) => step.done).length;
  return (
    <>
      <AppText variant="label">
        {t("questsTab.passport", {
          done: formatNumber(Math.min(done, view.needed), language),
          needed: formatNumber(view.needed, language),
        })}
      </AppText>
      <AppText muted>
        {t("play.passport.howTo", { needed: formatNumber(view.needed, language) })}
      </AppText>
      {view.steps.map((step) => (
        <View key={step.id} accessibilityLabel={textIn(step.name, language)}>
          <AppText>{textIn(step.name, language)}</AppText>
          <AppText muted>{t(step.done ? "play.passport.stamped" : "play.passport.open")}</AppText>
        </View>
      ))}
      {quest.state === "open" ? (
        <Button
          label={t("play.passport.scan")}
          onPress={() =>
            router.push({ pathname: "/event/[eventId]/scan-quest", params: { eventId } })
          }
        />
      ) : null}
    </>
  );
}
