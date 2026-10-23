import type { LocalizedText } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { Share } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { completedText } from "#src/event/amount.ts";
import { useTerms } from "#src/event/EventContext.tsx";
import type { Quest } from "#src/event/quests-api.ts";
import {
  fetchShare,
  sendShare,
  shareText,
  shared,
  type ShareView,
} from "#src/event/survey-share.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";

/**
 * A share quest in the quest sheet (FR-220, ADR-034): the organizer's message goes to the phone's share sheet, where the
 * player picks the app and the people; the points come once the sheet says it was shared. The link is shown as text,
 * never opened by the app. A retry keeps the same key, so the points are never paid twice.
 */
export function ShareEntry({ quest, onPaid }: Readonly<{ quest: Quest; onPaid: () => void }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const [view, setView] = useState<ShareView | undefined | "failed">(undefined);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [key, setKey] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setView((await fetchShare(api.session, quest.id)) ?? "failed");
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
  const message = textIn(view.message, language);
  const pay = async (paidKey: string) => {
    setBusy(true);
    setProblem(null);
    const answer = await sendShare(api.session, quest.id, paidKey);
    setBusy(false);
    if (answer.kind === "voted") {
      setSaid(`${t("play.share.thanks")} ${completedText(t, terms, language, answer.points)}`);
      onPaid();
      await load();
    } else if (answer.kind === "refused") {
      setProblem(answer.message);
    } else if (answer.kind === "network") {
      setSaid(t("join.network"));
    }
  };
  const share = async () => {
    setSaid(null);
    try {
      const result = await Share.share({ message: shareText(message, view.link) });
      if (!shared(result.action)) {
        return;
      }
    } catch {
      setSaid(t("play.share.failed"));
      return;
    }
    const paidKey = key ?? randomUuid();
    setKey(paidKey);
    await pay(paidKey);
  };
  return (
    <>
      {said === null ? null : <AppText accessibilityRole="alert">{said}</AppText>}
      <Problem problem={problem} />
      <AppText variant="label">{t("play.share.message")}</AppText>
      <AppText>{message}</AppText>
      {view.link === null ? null : (
        <AppText muted style={{ writingDirection: "ltr" }}>
          {view.link}
        </AppText>
      )}
      {view.done ? (
        <AppText variant="label">{t("play.share.done")}</AppText>
      ) : quest.state === "open" ? (
        <>
          <Button label={t("play.share.send")} disabled={busy} onPress={() => void share()} />
          {key === undefined || said !== t("join.network") ? null : (
            <Button kind="quiet" label={t("common.retry")} onPress={() => void pay(key)} />
          )}
        </>
      ) : null}
    </>
  );
}
