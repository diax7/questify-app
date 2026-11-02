import { MESSAGES, type MessageKey } from "@questify/shared";
import { Linking, View } from "react-native";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import type { BanNotice } from "#src/auth/sign-in-flow.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** The words for a ban's reason code, or null for a code this app does not know (a newer API) or none. */
export function banReasonKey(reason: string | null): MessageKey | null {
  if (reason === null) {
    return null;
  }
  const key = `ban.reason.${reason.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase())}`;
  return Object.hasOwn(MESSAGES, key) ? (key as MessageKey) : null;
}

/**
 * What a banned account sees after the right code (FR-1417, FR-1606): that the account is suspended, the reason in
 * fixed words, and the address to appeal to as a mail link. Nothing is sent by email (ADR-423).
 */
export function BannedNotice({ notice }: Readonly<{ notice: BanNotice }>) {
  const { t } = useI18n();
  const reason = banReasonKey(notice.reason);
  return (
    <View style={{ gap: 12 }} accessibilityLiveRegion="polite">
      <AppText variant="title" accessibilityRole="header">
        {t("ban.title")}
      </AppText>
      {reason === null ? null : <AppText>{t("ban.reason", { reason: t(reason) })}</AppText>}
      {notice.appealEmail === "" ? null : (
        <>
          <AppText>{t("ban.appeal")}</AppText>
          <Button
            kind="quiet"
            label={isolatedLtr(notice.appealEmail)}
            accessibilityLabel={t("ban.appealLabel", { email: notice.appealEmail })}
            onPress={() => void Linking.openURL(`mailto:${notice.appealEmail}`)}
          />
        </>
      )}
    </View>
  );
}
