import {
  formatLocalDate,
  type Language,
  type OwnEvent,
  type PublicStamp,
  type Theme,
} from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useQuestifySync } from "#src/questify/QuestifySyncProvider.tsx";
import { emblemOf, stampState, stateText } from "#src/questify/stamps.ts";
import { useEventPages } from "#src/questify/use-read.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Bilingual = Readonly<{ ar: string; en: string }>;

/** The text in the screen's language, else the other one (an organizer may have written only one). */
export const wordsIn = (text: Bilingual, language: Language): string =>
  text[language] || text[language === "ar" ? "en" : "ar"];

type StampProps = Readonly<{
  name: Bilingual;
  date: string;
  city: Bilingual | null;
  /** The line after the date: the rank, "Results soon", "Live now" and so on; none for a stamp with no rank. */
  line: string | null;
  /** The owner sees stamps other players do not (FR-709); this one says so. */
  ownerOnly: boolean;
}>;

/** One passport stamp: the emblem (the name's first letter until events have logos, T-602), name, date and city. */
export function StampCard({ name, date, city, line, ownerOnly }: StampProps) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const title = wordsIn(name, language);
  const where = city === null ? null : wordsIn(city, language);
  return (
    <View accessible style={styles.stamp}>
      <View accessibilityElementsHidden style={styles.emblem}>
        <AppText variant="title">{emblemOf(name, language)}</AppText>
      </View>
      <AppText variant="label" style={styles.center}>
        {title}
      </AppText>
      <AppText muted style={styles.center}>
        {formatLocalDate(date, language)}
      </AppText>
      {where === null ? null : (
        <AppText muted style={styles.center}>
          {where}
        </AppText>
      )}
      {line === null ? null : (
        <AppText variant="label" style={styles.center}>
          {line}
        </AppText>
      )}
      {ownerOnly ? (
        <AppText muted style={styles.center}>
          {t("passport.private")}
        </AppText>
      ) : null}
    </View>
  );
}

function OwnStamp({ event }: Readonly<{ event: OwnEvent }>) {
  const { t } = useI18n();
  const text = stateText(stampState(event));
  return (
    <StampCard
      name={event.name}
      date={event.date}
      city={event.city}
      line={t(text.key, text.params)}
      ownerOnly={!event.isPublic}
    />
  );
}

/** Your Event Passport (FR-709): a stamp for every event you played, newest first, with its date and final rank. */
export function OwnPassport() {
  const { t } = useI18n();
  const { version } = useQuestifySync();
  const styles = useThemedStyles(makeStyles);
  const pages = useEventPages(true, [version]);
  return (
    <View style={styles.section}>
      <AppText variant="title">{t("passport.title")}</AppText>
      {pages.failed ? (
        <>
          <AppText accessibilityRole="alert">{t("passport.failed")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={pages.retry} />
        </>
      ) : null}
      {pages.rows?.length === 0 ? <AppText muted>{t("passport.empty")}</AppText> : null}
      <View style={styles.grid}>
        {(pages.rows ?? []).map((event) => (
          <OwnStamp key={event.eventId} event={event} />
        ))}
      </View>
      {pages.more === null ? null : (
        <Button kind="quiet" label={t("locker.more")} onPress={pages.more} />
      )}
    </View>
  );
}

/** Another player's passport: only the stamps the server sent (ended public events), each with its rank if it has one. */
export function PublicPassport({ stamps }: Readonly<{ stamps: readonly PublicStamp[] }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <AppText variant="title">{t("passport.title")}</AppText>
      {stamps.length === 0 ? <AppText muted>{t("passport.publicEmpty")}</AppText> : null}
      <View style={styles.grid}>
        {stamps.map((stamp, index) => (
          <StampCard
            // A stamp has no id by design (no event id is sent): the order is the key.
            key={`${stamp.date}:${index}`}
            name={stamp.name}
            date={stamp.date}
            city={stamp.city}
            line={stamp.rank === null ? null : t("passport.rank", { rank: stamp.rank })}
            ownerOnly={false}
          />
        ))}
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  section: { gap: theme.spacing.md },
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: theme.spacing.md },
  center: { textAlign: "center" as const },
  stamp: {
    width: "47%" as const,
    alignItems: "center" as const,
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderStyle: "dashed" as const,
    borderColor: theme.colors.textMuted,
    backgroundColor: theme.colors.surface,
  },
  emblem: {
    width: 48,
    height: 48,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: 24,
    borderWidth: 3,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.background,
  },
});
