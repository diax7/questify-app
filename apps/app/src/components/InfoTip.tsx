import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { IconButton } from "#src/components/IconButton.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * A label with an info button beside it (ADR-370): a tap opens the explanation under the label and a second tap closes
 * it. It is for a setting or field that truly needs explaining; a line that only repeats its label is cut instead.
 * `subject` is the label's text, so each button reads "More information: label" and says whether it is open.
 */
export function InfoTip({
  info,
  subject,
  children,
}: Readonly<{ info: string; subject: string; children: ReactNode }>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ flexShrink: 1, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginVertical: -8 }}>
        <View style={{ flexShrink: 1 }}>{children}</View>
        <IconButton
          icon={open ? "information-circle" : "information-circle-outline"}
          label={`${t("common.info")}: ${subject}`}
          expanded={open}
          onPress={() => setOpen((now) => !now)}
        />
      </View>
      {open ? <AppText muted>{info}</AppText> : null}
    </View>
  );
}
