import type { ComposedConfig } from "@questify/shared";
import { AppText } from "#src/components/AppText.tsx";
import { bannerMessage, maintenanceMessage, switchedOffMessages } from "#src/config/notices.ts";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * What Questify says on Home, from the platform configuration Home holds, in the player's language: why play is paused
 * (T-703b, FR-1771), the scheduled banner while its window is open (FR-1772), and the messages of the features it switched
 * off (T-703, FR-1769). The features themselves are already hidden; nothing at all when there is nothing to say or no
 * configuration yet (Home reads the last working copy first and again each time it gains focus).
 */
export function PlatformNotices({ config }: Readonly<{ config: ComposedConfig | undefined }>) {
  const { language } = useI18n();
  const texts = [
    maintenanceMessage(config, language),
    bannerMessage(config, language, Date.now()),
    ...switchedOffMessages(config, language),
  ].filter((text): text is string => text !== null);
  return (
    <>
      {[...new Set(texts)].map((text) => (
        <AppText key={text} accessibilityRole="alert">
          {text}
        </AppText>
      ))}
    </>
  );
}
