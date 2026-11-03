import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { loadConfig } from "#src/config/remote.ts";
import { bannerMessage, maintenanceMessage, switchedOffMessages } from "#src/config/notices.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useRead } from "#src/questify/use-read.ts";

/**
 * What Questify says on Home, from the platform configuration in the player's language, read again each time Home gains
 * focus: why play is paused (T-703b, FR-1771), the scheduled banner while its window is open (FR-1772), and the messages
 * of the features it switched off (T-703, FR-1769). The features themselves are already hidden; nothing at all when there
 * is nothing to say or the configuration cannot be read (the last working copy is used first).
 */
export function PlatformNotices() {
  const { language } = useI18n();
  const config = useRead(
    async () => (await loadConfig({ client: api.client, store: keyValueStore })) ?? null,
    [],
  ).data;
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
