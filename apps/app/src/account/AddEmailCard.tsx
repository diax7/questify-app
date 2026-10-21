import type { Theme } from "@questify/shared";
import { router, useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { keyValueStore } from "#src/api/app-session.ts";
import { ADD_EMAIL_SHOWN_KEY, offersAddEmail } from "#src/account/add-email.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The add-email invitation (FR-1817): shown once per sign-in on this phone to a phone-only player, on whichever home
 * the player sees first (the marker is a player key, cleared at sign-out). It is marked as shown when it appears, so
 * skipping, adding or leaving all count as the one time.
 */
export function AddEmailCard() {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const { state } = usePlayer();
  const me = state.status === "signed_in" ? state.me : undefined;
  const [visible, setVisible] = useState(false);
  // A home left mounted under another screen must not use up the one time (sign-in replaces it, the join card too).
  const focused = useIsFocused();

  useEffect(() => {
    if (!focused || !offersAddEmail(me, false)) {
      return;
    }
    void (async () => {
      const shown = await keyValueStore.getItem(ADD_EMAIL_SHOWN_KEY).catch(() => null);
      if (offersAddEmail(me, shown !== null)) {
        setVisible(true);
        await keyValueStore.setItem(ADD_EMAIL_SHOWN_KEY, "1").catch(() => undefined);
      }
    })();
  }, [focused, me]);

  if (!visible) {
    return null;
  }
  return (
    <View style={styles.card}>
      <AppText variant="title">{t("addEmail.title")}</AppText>
      <AppText>{t("addEmail.body")}</AppText>
      <Button
        label={t("account.addEmail")}
        onPress={() => {
          setVisible(false);
          router.push({ pathname: "/account", params: { channel: "email" } });
        }}
      />
      <Button kind="quiet" label={t("addEmail.skip")} onPress={() => setVisible(false)} />
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
