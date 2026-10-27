import type { EventRecap } from "@questify/shared";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, type View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { RecapCard } from "#src/event/RecapCard.tsx";
import { fetchRecap, type RecapAnswer } from "#src/event/recap-api.ts";
import { createRecapSharer, type RecapSharer } from "#src/event/recap-share.ts";
import { recapShareDeps } from "#src/event/recap-share-native.ts";
import { recapShareText, recapView } from "#src/event/recap.ts";
import { useI18n } from "#src/i18n/provider.tsx";

/** The recap, read once the screen opens; a signed-out session goes home. */
function useRecap(eventId: string) {
  const [answer, setAnswer] = useState<RecapAnswer | undefined>(undefined);
  const load = useCallback(async () => {
    setAnswer(undefined);
    const loaded = await fetchRecap(api.session, eventId);
    if (loaded.kind === "signed_out") {
      router.replace("/home");
      return;
    }
    setAnswer(loaded);
  }, [eventId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { answer, load };
}

/**
 * The share: the card as an image, or one fixed line of text on a build without the two native modules. The last
 * capture is deleted when the screen closes (and before the next capture, inside the sharer).
 */
function useShare(recap: EventRecap | undefined, card: React.RefObject<View | null>) {
  const { t, language } = useI18n();
  const sharerRef = useRef<RecapSharer | undefined>(undefined);
  sharerRef.current ??= createRecapSharer(recapShareDeps);
  const sharer = sharerRef.current;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => sharer.release(), [sharer]);
  const share = async () => {
    if (recap === undefined) {
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      await sharer.share(card, {
        message: recapShareText(recap, language, t),
        dialogTitle: t("recap.share"),
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return { share, busy, failed };
}

const MESSAGE_OF = {
  gone: "recap.gone",
  not_ended: "recap.notEnded",
  network: "recap.failed",
} as const;

/** Why there is no card: still loading, or the answer's words, with Try again when only the connection failed. */
function RecapStatus({
  answer,
  onRetry,
}: Readonly<{ answer: RecapAnswer | undefined; onRetry: () => void }>) {
  const { t } = useI18n();
  if (answer === undefined) {
    return <AppText muted>{t("common.loading")}</AppText>;
  }
  if (answer.kind === "recap" || answer.kind === "signed_out") {
    return null;
  }
  return (
    <>
      <AppText accessibilityRole="alert">{t(MESSAGE_OF[answer.kind])}</AppText>
      {answer.kind === "network" ? <Button label={t("common.retry")} onPress={onRetry} /> : null}
    </>
  );
}

/** The player's recap of the event that ended (FR-752): the card, and Share. */
export default function RecapScreen() {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const { answer, load } = useRecap(eventId);
  const card = useRef<View>(null);
  const recap = answer?.kind === "recap" ? answer.recap : undefined;
  const { share, busy, failed } = useShare(recap, card);
  return (
    <Screen title={t("recap.title")} header={<BackButton />}>
      <RecapStatus answer={answer} onRetry={() => void load()} />
      {recap === undefined ? null : (
        <ScrollView contentContainerStyle={{ gap: 16 }}>
          <RecapCard view={recapView(recap, language, t)} cardRef={card} />
          {failed ? <AppText accessibilityRole="alert">{t("recap.shareFailed")}</AppText> : null}
          <Button label={t("recap.share")} disabled={busy} onPress={() => void share()} />
        </ScrollView>
      )}
    </Screen>
  );
}
