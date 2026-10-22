import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import type { JoinCard } from "#src/join/join-api.ts";

/** What the organizer will see (FR-121, PD-17), as the card in force says it. */
export function CardReceives({ card }: Readonly<{ card: JoinCard | undefined }>) {
  const { language } = useI18n();
  if (card === undefined) {
    return null;
  }
  return (
    <>
      <AppText variant="title">{card.title[language]}</AppText>
      {card.receives.map((item) => (
        <AppText key={item.en}>• {item[language]}</AppText>
      ))}
    </>
  );
}
