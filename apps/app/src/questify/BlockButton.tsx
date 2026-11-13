import { useState } from "react";
import { showAlert } from "#src/platform/alert.ts";
import { api } from "#src/api/app-session.ts";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { setBlocked } from "#src/questify/blocks-api.ts";

/**
 * Block on a player's profile (FR-1415, T-705): asked once (ADR-063), then the profile is replaced by a line that says
 * so and an Unblock button. A blocked player's profile is not found afterwards, so the choice lives on this screen and
 * in Settings, Blocked players.
 */
export function BlockButton({
  username,
  onChange,
}: Readonly<{ username: string; onChange: (blocked: boolean) => void }>) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = isolatedLtr(`@${username}`);
  const save = async (blocked: boolean) => {
    setBusy(true);
    const saved = await setBlocked(api.session, username, blocked);
    setBusy(false);
    setFailed(!saved);
    if (saved) {
      onChange(blocked);
    }
  };
  const ask = () =>
    showAlert(t("block.action"), t("block.confirm", { name }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("block.action"), style: "destructive", onPress: () => void save(true) },
    ]);
  return (
    <>
      <Button kind="quiet" label={t("block.action")} disabled={busy} onPress={ask} />
      {failed ? <AppText accessibilityLiveRegion="polite">{t("block.failed")}</AppText> : null}
    </>
  );
}

/** What the profile shows once the player is blocked: that it is, and Unblock. */
export function BlockedLine({
  username,
  onChange,
}: Readonly<{ username: string; onChange: (blocked: boolean) => void }>) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = isolatedLtr(`@${username}`);
  return (
    <>
      <AppText accessibilityLiveRegion="polite">{t("block.done", { name })}</AppText>
      <Button
        kind="quiet"
        label={t("block.undo")}
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void setBlocked(api.session, username, false).then((saved) => {
            setBusy(false);
            setFailed(!saved);
            if (saved) {
              onChange(false);
            }
          });
        }}
      />
      {failed ? <AppText>{t("block.failed")}</AppText> : null}
    </>
  );
}
