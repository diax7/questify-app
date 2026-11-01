import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import type { JoinCard } from "#src/join/join-api.ts";

/**
 * What the organizer will see (FR-121, PD-17), as the card in force says it, and, when the event shows full names, who
 * will see the player's (FR-1842): the join sends that audience back, so what is read here is what is recorded.
 */
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
      {card.nameNotice === null ? null : (
        <AppText accessibilityRole="text">{card.nameNotice.text[language]}</AppText>
      )}
    </>
  );
}
