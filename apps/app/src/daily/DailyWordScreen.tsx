import { WORD_LENGTH } from "@questify/shared";
import type { DailyLanguage, DailyWordGame, MessageKey, Theme } from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { postGuess } from "#src/daily/daily-api.ts";
import { stepAfterMove } from "#src/daily/daily-flow.ts";
import { nextLine } from "#src/daily/daily-lines.ts";
import {
  keyMarks,
  marksOf,
  MAX_ATTEMPTS,
  nextAttempt,
  withGuess,
  wordIdFor,
  wordLanguage,
} from "#src/daily/daily-state.ts";
import { gridDirection } from "#src/daily/keyboard.ts";
import { DailyGate } from "#src/daily/DailyGate.tsx";
import {
  useAfterFinish,
  useCelebrateWhen,
  useOwnDaily,
  type DailyRead,
} from "#src/daily/use-daily.ts";
import { Legend, SrOnly, Tile, WordKeyboard } from "#src/daily/WordParts.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { PopIn } from "#src/components/motion.tsx";
import type { LevelUp } from "#src/questify/level.ts";
import { ProfileGate } from "#src/questify/ProfileGate.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

// Each language is named in itself, as on the language switch.
const LANGUAGE_NAMES: Readonly<Record<DailyLanguage, string>> = { ar: "العربية", en: "English" };

const FIRST_STRONG_ISOLATE = 0x2068;
const POP_ISOLATE = 0x2069;
/** How long the last marks stay on screen alone before a level-up card covers them. */
const LEVEL_UP_DELAY_MS = 1000;

/** Wraps a word in a first-strong isolate, so an Arabic word in an English sentence (or the reverse) keeps its order. */
const isolated = (text: string): string =>
  `${String.fromCodePoint(FIRST_STRONG_ISOLATE)}${text}${String.fromCodePoint(POP_ISOLATE)}`;

type Finished = NonNullable<NonNullable<DailyWordGame["play"]>["finished"]>;

/** The end of the game: how it went, the word as written, the XP and when the next word comes. */
function ResultCard({ finished, word }: Readonly<{ finished: Finished; word: DailyWordGame }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <PopIn>
        <AppText variant="title" accessibilityRole="header">
          {t(finished.solved ? "daily.word.solvedTitle" : "daily.word.missedTitle")}
        </AppText>
        {finished.solved ? (
          <>
            <AppText>{t("daily.word.solvedIn", { attempts: finished.attempts })}</AppText>
            <AppText variant="display">{isolated(finished.word)}</AppText>
          </>
        ) : (
          <AppText variant="title">
            {t("daily.word.revealed", { word: isolated(finished.word) })}
          </AppText>
        )}
        {finished.xp > 0 ? (
          <AppText variant="title">{t("daily.xp", { xp: finished.xp })}</AppText>
        ) : null}
        <AppText muted>{nextLine("word", word.period, new Date(), t)}</AppText>
      </PopIn>
    </View>
  );
}

function LanguagePicker(
  props: Readonly<{
    languages: readonly DailyLanguage[];
    chosen: DailyLanguage;
    onPick: (language: DailyLanguage) => void;
  }>,
) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.picker}>
      <AppText variant="label">{t("daily.word.language")}</AppText>
      <View style={styles.pickerRow}>
        {props.languages.map((language) => (
          <View key={language} style={styles.pickerItem}>
            <Button
              kind={language === props.chosen ? "primary" : "quiet"}
              selected={language === props.chosen}
              label={LANGUAGE_NAMES[language]}
              onPress={() => props.onPick(language)}
            />
          </View>
        ))}
      </View>
      <AppText muted>{t("daily.word.languageOnce")}</AppText>
    </View>
  );
}

type Row = Readonly<{ letters: readonly string[]; marks: ReadonlyArray<0 | 1 | 2> | null }>;

/** Six rows: the guesses played, the one being typed, and empty rows after it. */
function rowsOf(word: DailyWordGame, typed: readonly string[]): Row[] {
  const played = word.play?.guesses ?? [];
  const over = word.play?.finished != null;
  return Array.from({ length: MAX_ATTEMPTS }, (_, index): Row => {
    const guess = played[index];
    if (guess !== undefined) return { letters: [...guess.guess], marks: marksOf(guess.marks) };
    return { letters: index === played.length && !over ? typed : [], marks: null };
  });
}

function Grid(
  props: Readonly<{ language: DailyLanguage; word: DailyWordGame; typed: readonly string[] }>,
) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.grid}>
      <SrOnly text={t("daily.word.grid")} />
      {rowsOf(props.word, props.typed).map((row, rowIndex) => (
        <View key={rowIndex} style={[styles.row, { direction: gridDirection(props.language) }]}>
          {Array.from({ length: WORD_LENGTH }, (_, index) => (
            <Tile
              key={index}
              language={props.language}
              letter={row.letters[index]}
              mark={row.marks?.[index] ?? null}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

/** Typing, sending a guess and what each answer does. */
function useGuessing(read: DailyRead, word: DailyWordGame, language: DailyLanguage) {
  const afterFinish = useAfterFinish();
  const [typed, setTyped] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [levelUp, setLevelUp] = useState<LevelUp | null>(null);
  // The level-up card follows the last marks by a second, so they are seen first.
  useCelebrateWhen(levelUp, word.play?.finished != null, LEVEL_UP_DELAY_MS);
  const wordId = wordIdFor(word, language);

  const send = async () => {
    if (busy || wordId === null) return;
    setBusy(true);
    setNotice(null);
    const outcome = await postGuess(api.session, {
      wordId,
      attempt: nextAttempt(word),
      guess: typed.join(""),
    });
    const step = stepAfterMove(outcome, "word");
    if (step.leave) {
      router.replace("/home");
      return;
    }
    if (outcome.kind === "ok") {
      const { reply } = outcome;
      read.update((current) =>
        current.word === null
          ? current
          : { ...current, word: withGuess(current.word, { language, wordId }, reply) },
      );
      setTyped([]);
      if (reply.finished !== null) {
        setLevelUp(reply.levelUp);
        afterFinish();
      }
    }
    setNotice(step.notice);
    if (step.reread) {
      setTyped([]);
      await read.load();
    }
    setBusy(false);
  };
  const onEnter = () => {
    if (typed.length < WORD_LENGTH) setNotice("daily.word.refusedLength");
    else void send();
  };
  return {
    typed,
    busy,
    notice,
    onLetter: (letter: string) => {
      setNotice(null);
      setTyped((current) => (current.length < WORD_LENGTH ? [...current, letter] : current));
    },
    onDelete: () => setTyped((current) => current.slice(0, -1)),
    onEnter,
  };
}

/** Above the grid: the language choice before the first guess, then which try this is. */
function PlayHeader(
  props: Readonly<{
    word: DailyWordGame;
    language: DailyLanguage;
    onPick: (language: DailyLanguage) => void;
  }>,
) {
  const { t } = useI18n();
  const { word } = props;
  if (word.play === null && word.languages.length > 1) {
    return (
      <LanguagePicker languages={word.languages} chosen={props.language} onPick={props.onPick} />
    );
  }
  if (word.play?.finished != null) return null;
  return (
    <AppText muted>
      {t("daily.word.attempt", { attempt: nextAttempt(word), total: MAX_ATTEMPTS })}
    </AppText>
  );
}

function Notice({ notice }: Readonly<{ notice: MessageKey | null }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (notice === null) return null;
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>
      <AppText>{t(notice)}</AppText>
    </View>
  );
}

/** Below the grid: the keyboard while the game is on, the result card once it is over. */
function WordFooter(
  props: Readonly<{
    word: DailyWordGame;
    language: DailyLanguage;
    guessing: ReturnType<typeof useGuessing>;
  }>,
) {
  const finished = props.word.play?.finished ?? null;
  if (finished !== null) return <ResultCard finished={finished} word={props.word} />;
  return (
    <WordKeyboard
      language={props.language}
      marks={keyMarks(props.word.play?.guesses ?? [])}
      disabled={props.guessing.busy}
      onLetter={props.guessing.onLetter}
      onDelete={props.guessing.onDelete}
      onEnter={props.guessing.onEnter}
    />
  );
}

function WordPlay({ read, word }: Readonly<{ read: DailyRead; word: DailyWordGame }>) {
  const { t, language: appLanguage } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [picked, setPicked] = useState<DailyLanguage | null>(null);
  const language = wordLanguage(word, picked ?? appLanguage);
  const guessing = useGuessing(read, word, language ?? "en");
  if (language === null) return <AppText muted>{t("daily.word.none")}</AppText>;
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <PlayHeader word={word} language={language} onPick={setPicked} />
      <Grid language={language} word={word} typed={guessing.typed} />
      <Notice notice={guessing.notice} />
      <Legend />
      <WordFooter word={word} language={language} guessing={guessing} />
    </ScrollView>
  );
}

function WordBody() {
  const { t } = useI18n();
  const read = useOwnDaily();
  return (
    <DailyGate read={read}>
      {(daily) =>
        daily.word === null ? (
          <AppText muted>{t("daily.word.none")}</AppText>
        ) : (
          <WordPlay read={read} word={daily.word} />
        )
      }
    </DailyGate>
  );
}

/**
 * The daily word (T-406b, FR-1810): six tries at a five-letter word with the app's own keyboard. The grid and the
 * keyboard follow the word's language, marks use colour and a shape, and nothing counts down (ADR-300).
 */
export function DailyWordScreen() {
  const { t } = useI18n();
  const { state } = usePlayer();
  const me = state.status === "signed_in" ? state.me : undefined;
  return (
    <Screen title={t("daily.word.title")} header={<BackButton />}>
      {me === undefined ? <ProfileGate /> : <WordBody key={me.id} />}
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  body: { gap: theme.spacing.md, paddingBottom: theme.spacing.xl },
  grid: { gap: 6, alignSelf: "center" as const, width: "100%" as const, maxWidth: 320 },
  row: { flexDirection: "row" as const, gap: 6 },
  picker: { gap: theme.spacing.sm },
  pickerRow: { flexDirection: "row" as const, gap: theme.spacing.sm },
  pickerItem: { flex: 1 },
  notice: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.surface,
  },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.xl,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.surface,
  },
});
