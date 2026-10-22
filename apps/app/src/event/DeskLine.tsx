import { formatTimeWindow } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import type { DeskInfo } from "#src/operator/desk.ts";

/**
 * Where and when to pick up (FR-1716): the desk's place, then its hours in the event's zone, or that it is open the
 * whole time, and a line when it is closed right now.
 */
export function DeskLine({ desk }: Readonly<{ desk: DeskInfo }>) {
  const { t, language } = useI18n();
  const place = desk.location === null ? "" : textIn(desk.location, language);
  return (
    <View style={{ gap: 4 }}>
      {place === "" ? null : <AppText variant="label">{t("shop.desk", { place })}</AppText>}
      {desk.hours === null ? (
        <AppText muted>{t("shop.deskAlwaysOpen")}</AppText>
      ) : (
        desk.hours.map((window) => (
          <AppText key={window.opensAt} muted>
            {formatTimeWindow(
              new Date(window.opensAt),
              new Date(window.closesAt),
              desk.timeZone,
              language,
            )}
          </AppText>
        ))
      )}
      {desk.state === "closed" ? <AppText>{t("shop.deskClosed")}</AppText> : null}
    </View>
  );
}
