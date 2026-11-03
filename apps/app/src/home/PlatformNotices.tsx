import type { ComposedConfig } from "@questify/shared";
import { AppText } from "#src/components/AppText.tsx";
import { switchedOffMessages } from "#src/config/notices.ts";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * What Questify says about the features it switched off (T-703, FR-1769): the messages from the platform configuration,
 * in the player's language, from the configuration Home holds. The feature itself is already hidden; nothing at all
 * when there is no message or the configuration cannot be read.
 */
export function PlatformNotices({ config }: Readonly<{ config: ComposedConfig | undefined }>) {
  const { language } = useI18n();
  return (
    <>
      {switchedOffMessages(config, language).map((text) => (
        <AppText key={text} accessibilityRole="alert">
          {text}
        </AppText>
      ))}
    </>
  );
}
