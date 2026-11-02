import type { BlockedPlayer } from "@questify/shared";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { readBlocks, setBlocked } from "#src/questify/blocks-api.ts";

function BlockedRow({
  player,
  onUnblocked,
}: Readonly<{ player: BlockedPlayer; onUnblocked: () => void }>) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Avatar name={player.avatar} username={player.username} size={40} />
      <AppText style={{ flex: 1, writingDirection: "ltr" }} numberOfLines={1}>
        {isolatedLtr(`@${player.username}`)}
      </AppText>
      <Button
        kind="quiet"
        label={t("block.undo")}
        accessibilityLabel={`${t("block.undo")} @${player.username}`}
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void setBlocked(api.session, player.username, false).then((saved) => {
            setBusy(false);
            setFailed(!saved);
            if (saved) {
              onUnblocked();
            }
          });
        }}
      />
      {failed ? <AppText>{t("block.failed")}</AppText> : null}
    </View>
  );
}

/** Settings → Blocked players (FR-1415, T-705): the players this player blocked, each with Unblock. */
export function BlockedPlayersScreen() {
  const { t } = useI18n();
  const [blocks, setBlocks] = useState<readonly BlockedPlayer[] | "loading" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void readBlocks(api.session).then((found) => {
      if (current) {
        setBlocks(found ?? "failed");
      }
    });
    return () => {
      current = false;
    };
  }, [attempt]);
  return (
    <Screen title={t("block.list")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {blocks === "loading" ? <AppText>{t("common.loading")}</AppText> : null}
        {blocks === "failed" ? (
          <>
            <AppText accessibilityLiveRegion="polite">{t("block.loadFailed")}</AppText>
            <Button label={t("common.retry")} onPress={() => setAttempt((n) => n + 1)} />
          </>
        ) : null}
        {Array.isArray(blocks) && blocks.length === 0 ? (
          <AppText>{t("block.empty")}</AppText>
        ) : null}
        {Array.isArray(blocks)
          ? blocks.map((player) => (
              <BlockedRow
                key={player.username}
                player={player}
                onUnblocked={() => setAttempt((n) => n + 1)}
              />
            ))
          : null}
      </ScrollView>
    </Screen>
  );
}
