import type { MessageKey } from "@questify/shared";
import { AppText } from "#src/components/AppText.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** A tab of the operator bar whose feature comes in a later task (FR-920: the bar keeps its final order now). */
export function ComingSoon({ title }: Readonly<{ title: MessageKey }>) {
  const { t } = useI18n();
  return (
    <Screen title={t(title)}>
      <AppText muted>{t("common.comingSoon")}</AppText>
    </Screen>
  );
}
