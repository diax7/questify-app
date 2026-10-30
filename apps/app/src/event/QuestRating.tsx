import type { QuestThumb } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { IconButton } from "#src/components/IconButton.tsx";
import {
  fetchRating,
  ratingViewOf,
  sendRating,
  type RatingRead,
  type RatingView,
} from "#src/event/quest-rating.ts";
import type { Quest } from "#src/event/quests-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * The optional thumbs up or down under a quest the player completed (FR-1211, FR-1623): shown only while the owner has
 * ratings on for the event, never blocks anything, and a skip is remembered so the prompt does not come back.
 */
export function QuestRating({ quest }: Readonly<{ quest: Quest }>) {
  const { t } = useI18n();
  const [read, setRead] = useState<RatingRead | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [justRated, setJustRated] = useState(false);
  const completed = quest.done > 0;
  useEffect(() => {
    if (!completed) return;
    let current = true;
    void fetchRating(api.session, quest.id).then((answer) => {
      if (current) setRead(answer);
    });
    return () => {
      current = false;
    };
  }, [quest.id, completed]);
  const send = useCallback(
    async (thumb: QuestThumb) => {
      setBusy(true);
      setFailed(false);
      const answer = await sendRating(api.session, quest.id, thumb);
      setBusy(false);
      if (answer.kind === "network") setFailed(true);
      else {
        setRead(answer);
        setJustRated(thumb !== "skip");
      }
    },
    [quest.id],
  );
  const view: RatingView = completed ? ratingViewOf(read) : "none";
  if (view === "none") return null;
  if (view !== "ask") {
    // The thanks answers the thumb sent a moment ago; a quest opened again with a thumb already given stays quiet.
    return justRated ? <AppText accessibilityRole="alert">{t("rating.thanks")}</AppText> : null;
  }
  return (
    <View style={{ gap: 8 }}>
      <AppText variant="label">{t("rating.prompt")}</AppText>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <IconButton
          icon="thumbs-up-outline"
          label={t("rating.up")}
          onPress={() => !busy && void send("up")}
        />
        <IconButton
          icon="thumbs-down-outline"
          label={t("rating.down")}
          onPress={() => !busy && void send("down")}
        />
        <Button
          kind="quiet"
          label={t("rating.skip")}
          disabled={busy}
          onPress={() => void send("skip")}
        />
      </View>
      {failed ? <AppText accessibilityRole="alert">{t("rating.failed")}</AppText> : null}
    </View>
  );
}
