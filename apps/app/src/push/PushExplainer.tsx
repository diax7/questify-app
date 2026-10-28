import { useEffect, useState } from "react";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { usePlayer } from "#src/auth/player.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { channelNames } from "#src/push/channels.ts";
import { explainerDue, snoozeExplainer, turnOn } from "#src/push/push-flow.ts";
import { pushDeps, whoOf } from "#src/push/use-push.ts";

export type JoinExplainer = Readonly<{
  visible: boolean;
  turnOnNow: () => void;
  notNow: () => void;
}>;

/**
 * The push explainer right after a successful join (FR-1105, ADR-349 (1)): never at launch, only when the system has
 * not been asked, and not again for 30 days after "Not now". "Turn on" is the only way to the system prompt. Nothing is
 * paid or opened for the answer (FR-1106).
 */
export function useJoinExplainer(joined: boolean): JoinExplainer {
  const { language, t } = useI18n();
  const { state } = usePlayer();
  const playerId = state.status === "signed_in" ? state.me?.id : undefined;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!joined) return;
    let current = true;
    void explainerDue(pushDeps())
      .then((due) => {
        if (current && due) setVisible(true);
      })
      // Nothing to explain when the phone cannot say; the join itself has already succeeded.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [joined]);
  return {
    visible,
    turnOnNow: () => {
      setVisible(false);
      void turnOn(pushDeps(), whoOf(language, playerId), channelNames(t)).catch(() => undefined);
    },
    notNow: () => {
      setVisible(false);
      void snoozeExplainer(pushDeps());
    },
  };
}

/** The explainer sheet; the shade, the back button and "Not now" all mean not now. */
export function PushExplainer({ explainer }: Readonly<{ explainer: JoinExplainer }>) {
  const { t } = useI18n();
  return (
    <Sheet
      visible={explainer.visible}
      title={t("push.explain.title")}
      onClose={explainer.notNow}
      closeLabel={t("push.explain.later")}
    >
      <AppText>{t("push.explain.body")}</AppText>
      <Button label={t("push.explain.on")} onPress={explainer.turnOnNow} />
    </Sheet>
  );
}
