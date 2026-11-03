import type { DailyChallenge, DailyWordGame, OwnDaily, Theme } from "@questify/shared";
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
 * The player's two daily games for Questify Home, read again when a sync wrote something and each time Home gains focus. One
 * read serves both cards. It is made only when `needed` (a layout can hide both cards); null while unread or when the
 * read fails, and the games' own screens say so.
 */
export function useHomeDaily(needed: boolean): OwnDaily | null {
  const { version } = useQuestifySync();
  return useRead(
    () => (needed ? fetchOwnDaily(api.session) : Promise.resolve(null)),
    [version, needed],
  ).data;
}

/** The daily challenge as a card on Questify Home (T-408b, T-713); no card for a game with no content or switched off. */
export function DailyChallengeCard({ daily }: Readonly<{ daily: OwnDaily | null }>) {
  return daily?.challenge == null ? null : <ChallengeCard challenge={daily.challenge} />;
}

/** The daily word as a card on Questify Home (T-408b, T-713); no card for a game with no content or switched off. */
export function DailyWordCard({ daily }: Readonly<{ daily: OwnDaily | null }>) {
  return daily?.word == null ? null : <WordCard word={daily.word} />;
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
