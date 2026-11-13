import { BackButton } from "#src/components/BackButton.tsx";
import { useState } from "react";
import { Linking, ScrollView } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { ABOUT_PAGES, webPageUrl, type WebPage } from "#src/legal/web-pages.ts";

/**
 * Profile → About and privacy (FR-1707, Q-769; Apple 5.1.1(i)): the privacy policy, terms, community guidelines, the
 * contact page and the web deletion page, each opened on the web in the app's language.
 */
export default function AboutScreen() {
  const { t, language } = useI18n();
  const [failed, setFailed] = useState(false);
  const open = (page: WebPage) => {
    setFailed(false);
    Linking.openURL(webPageUrl(language, page)).catch(() => setFailed(true));
  };
  return (
    <Screen title={t("about.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <AppText>{t("about.body")}</AppText>
        {ABOUT_PAGES.map((row) => (
          <Button key={row.page} kind="quiet" label={t(row.label)} onPress={() => open(row.page)} />
        ))}
        {failed ? <AppText accessibilityRole="alert">{t("home.link.failed")}</AppText> : null}
      </ScrollView>
    </Screen>
  );
}
