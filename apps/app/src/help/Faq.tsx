import { useEffect, useState } from "react";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { faqFrom, type FaqItem } from "#src/help/faq.ts";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * The common questions an admin wrote (FR-1782), above the ticket cards. Nothing shows while they load or when there are
 * none or they cannot be read: the cards below are the way to ask.
 */
export function Faq() {
  const { t, language } = useI18n();
  const [items, setItems] = useState<FaqItem[]>([]);
  useEffect(() => {
    let current = true;
    void api.session.request({ method: "GET", path: "/v1/help" }).then((answer) => {
      if (current && answer.kind === "ok") {
        setItems(faqFrom(answer.body, language) ?? []);
      }
    });
    return () => {
      current = false;
    };
  }, [language]);
  if (items.length === 0) {
    return null;
  }
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="title">{t("faq.title")}</AppText>
      {items.map((item) => (
        <View key={item.id} style={{ gap: 4 }}>
          <AppText variant="label">{item.question}</AppText>
          <AppText>{item.answer}</AppText>
        </View>
      ))}
    </View>
  );
}
