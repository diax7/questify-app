import type { DailyChallenge, DailyWordGame, Theme } from "@questify/shared";
import { router } from "expo-router";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { SponsorLine } from "#src/daily/DailyChallengeScreen.tsx";
import { fetchOwnDaily } from "#src/daily/daily-api.ts";
import { challengeCardLine, wordCardLine } from "#src/daily/daily-lines.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useQuestifySync } from "#src/questify/QuestifySyncProvider.tsx";
import { useRead } from "#src/questify/use-read.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

type CardProps = Readonly<{
  title: string;
  line: string;
  done: boolean;
  started: boolean;
  sponsor?: React.ReactNode;
  onOpen: () => void;
}>;

function GameCard({ title, line, done, started, sponsor, onOpen }: CardProps) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.card}>
      <AppText variant="title" accessibilityRole="header">
        {title}
      </AppText>
      {sponsor}
      <AppText muted>{line}</AppText>
      <Button
        kind={done ? "quiet" : "primary"}
        label={t(done ? "daily.seeResult" : started ? "daily.continue" : "daily.play")}
        accessibilityLabel={`${t(done ? "daily.seeResult" : started ? "daily.continue" : "daily.play")}: ${title}`}
        onPress={onOpen}
      />
    </View>
  );
}

function ChallengeCard({ challenge }: Readonly<{ challenge: DailyChallenge }>) {
  const { t } = useI18n();
  return (
    <GameCard
      title={t("daily.challenge.title")}
      line={challengeCardLine(challenge, t)}
      done={challenge.finished !== null}
      started={challenge.questions.some((question) => question.answered !== null)}
      sponsor={<SponsorLine sponsor={challenge.sponsor} />}
      onOpen={() => router.push("/daily-challenge")}
    />
  );
}

function WordCard({ word }: Readonly<{ word: DailyWordGame }>) {
  const { t } = useI18n();
  return (
    <GameCard
      title={t("daily.word.title")}
      line={wordCardLine(word, t)}
      done={word.play?.finished != null}
      started={word.play !== null}
      onOpen={() => router.push("/daily-word")}
    />
  );
}

/**
 * The two daily games as cards on the Profile's Questify section until Questify Home (T-408) takes them. A game with no
 * content, or switched off, shows no card; a read that fails shows none either, and the games' own screens say so.
 */
export function DailyCards() {
  const { t } = useI18n();
  const { version } = useQuestifySync();
  const daily = useRead(() => fetchOwnDaily(api.session), [version]).data;
  if (daily === null || (daily.challenge === null && daily.word === null)) return null;
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="title" accessibilityRole="header">
        {t("daily.title")}
      </AppText>
      {daily.challenge === null ? null : <ChallengeCard challenge={daily.challenge} />}
      {daily.word === null ? null : <WordCard word={daily.word} />}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
