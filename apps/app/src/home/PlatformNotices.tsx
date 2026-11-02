import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { loadConfig } from "#src/config/remote.ts";
import { switchedOffMessages } from "#src/config/notices.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useRead } from "#src/questify/use-read.ts";

/**
 * What Questify says about the features it switched off (T-703, FR-1769): the messages from the platform configuration,
 * in the player's language, read again each time Home gains focus. The feature itself is already hidden; nothing at all
 * when there is no message or the configuration cannot be read.
 */
export function PlatformNotices() {
  const { language } = useI18n();
  const config = useRead(
    async () => (await loadConfig({ client: api.client, store: keyValueStore })) ?? null,
    [],
  ).data;
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
