import { Ionicons } from "@expo/vector-icons";
import type { DailyLanguage, Theme } from "@questify/shared";
import { Pressable, useWindowDimensions, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import type { Mark } from "#src/daily/daily-state.ts";
import { gridDirection, KEY_ROWS, keyWidthFor, tileLetter } from "#src/daily/keyboard.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

type MarkKey = "daily.word.markRight" | "daily.word.markElsewhere" | "daily.word.markAbsent";

/** Each mark has a colour, a corner glyph and a border, so no mark is told by colour alone (WCAG 1.4.1). */
const MARKS: Readonly<
  Record<Mark, Readonly<{ glyph: "checkmark" | "radio-button-off" | "close"; label: MarkKey }>>
> = {
  2: { glyph: "checkmark", label: "daily.word.markRight" },
  1: { glyph: "radio-button-off", label: "daily.word.markElsewhere" },
  0: { glyph: "close", label: "daily.word.markAbsent" },
};

export const markLabel = (mark: Mark): MarkKey => MARKS[mark].label;

/** The small shape in a tile's corner that says what its colour says. */
function MarkGlyph({ mark, size }: Readonly<{ mark: Mark; size: number }>) {
  const styles = useThemedStyles(makeStyles);
  const { theme } = useTheme();
  return (
    <View pointerEvents="none" style={styles.glyph}>
      <Ionicons name={MARKS[mark].glyph} size={size} color={theme.colors.text} />
    </View>
  );
}

const markStyleOf = (styles: ReturnType<typeof makeStyles>, mark: Mark | null) => {
  if (mark === 2) return styles.right;
  if (mark === 1) return styles.elsewhere;
  return mark === 0 ? styles.absent : null;
};

type TileProps = Readonly<{
  language: DailyLanguage;
  /** The letter, or undefined for an empty tile. */
  letter: string | undefined;
  mark: Mark | null;
}>;

/** One tile of the grid; the letter stands alone, so Arabic shows its isolated form. */
export function Tile({ language, letter, mark }: TileProps) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const shown = letter === undefined ? undefined : tileLetter(language, letter);
  const label =
    shown === undefined
      ? t("daily.word.tileEmpty")
      : mark === null
        ? shown
        : t("daily.word.tile", { letter: shown, mark: t(markLabel(mark)) });
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[styles.tile, shown === undefined ? null : styles.filled, markStyleOf(styles, mark)]}
    >
      {mark === null ? null : <MarkGlyph mark={mark} size={14} />}
      <AppText variant="title" style={styles.tileText}>
        {shown ?? ""}
      </AppText>
    </View>
  );
}

/** What the three marks mean, drawn the way the tiles draw them. */
export function Legend() {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.legend}>
      {([2, 1, 0] as const).map((mark) => (
        <View key={mark} style={styles.legendItem}>
          <View style={[styles.swatch, markStyleOf(styles, mark)]}>
            <MarkGlyph mark={mark} size={12} />
          </View>
          <AppText muted>{t(markLabel(mark))}</AppText>
        </View>
      ))}
    </View>
  );
}

type KeyProps = Readonly<{
  language: DailyLanguage;
  marks: ReadonlyMap<string, Mark>;
  disabled: boolean;
  onLetter: (letter: string) => void;
  onDelete: () => void;
  onEnter: () => void;
}>;

/** Text for a screen reader only. iOS reads a label only from an element it can focus, so a container's own label is lost. */
export function SrOnly({ text }: Readonly<{ text: string }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <AppText accessibilityRole="header" style={styles.srOnly}>
      {text}
    </AppText>
  );
}

function LetterKey(
  props: Readonly<{
    language: DailyLanguage;
    letter: string;
    mark: Mark | null;
    width: number;
    disabled: boolean;
    onPress: (letter: string) => void;
  }>,
) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const shown = tileLetter(props.language, props.letter);
  const label =
    props.mark === null
      ? shown
      : t("daily.word.tile", { letter: shown, mark: t(markLabel(props.mark)) });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onPress(props.letter)}
      style={[
        styles.key,
        { width: props.width },
        markStyleOf(styles, props.mark),
        props.disabled && styles.keyDisabled,
      ]}
    >
      {props.mark === null ? null : <MarkGlyph mark={props.mark} size={10} />}
      <AppText variant="label">{shown}</AppText>
    </Pressable>
  );
}

/** Enter and Delete, on a row of their own under the letters, each as wide as half the row. */
function ActionRow(
  props: Readonly<{
    language: DailyLanguage;
    disabled: boolean;
    onDelete: () => void;
    onEnter: () => void;
  }>,
) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.keyRow, { direction: gridDirection(props.language) }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        onPress={props.onEnter}
        style={[styles.key, styles.wideKey, styles.enterKey, props.disabled && styles.keyDisabled]}
      >
        <AppText variant="label">{t("daily.word.enter")}</AppText>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        onPress={props.onDelete}
        style={[styles.key, styles.wideKey, props.disabled && styles.keyDisabled]}
      >
        <AppText variant="label">{t("daily.word.delete")}</AppText>
      </Pressable>
    </View>
  );
}

/**
 * The app's own keyboard: every letter of the language, in the language's reading direction. Every key has one width,
 * the widest the screen allows for the longest row, so keys stay even and a short row is centred.
 */
export function WordKeyboard({ language, marks, disabled, onLetter, onDelete, onEnter }: KeyProps) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { width: screenWidth } = useWindowDimensions();
  const rows = KEY_ROWS[language];
  const width = keyWidthFor(
    screenWidth,
    theme.spacing.xl,
    theme.spacing.xs,
    Math.max(...rows.map((row) => row.length)),
  );
  return (
    <View style={styles.keyboard}>
      <SrOnly text={t("daily.word.keyboard")} />
      {rows.map((row) => (
        <View key={row.join("")} style={[styles.keyRow, { direction: gridDirection(language) }]}>
          {row.map((letter) => (
            <LetterKey
              key={letter}
              language={language}
              letter={letter}
              mark={marks.get(letter) ?? null}
              width={width}
              disabled={disabled}
              onPress={onLetter}
            />
          ))}
        </View>
      ))}
      <ActionRow language={language} disabled={disabled} onDelete={onDelete} onEnter={onEnter} />
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  tile: {
    flex: 1,
    aspectRatio: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: theme.radius.sm,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  filled: { borderColor: theme.colors.textMuted },
  tileText: { textAlign: "center" as const },
  // Right place: green, a solid thick border and a tick.
  right: {
    backgroundColor: theme.colors.primaryAction,
    borderColor: theme.colors.primaryAction,
    borderWidth: 3,
  },
  // Elsewhere: orange, a dashed border and a ring.
  elsewhere: {
    backgroundColor: theme.colors.highlight,
    borderColor: theme.colors.text,
    borderStyle: "dashed" as const,
  },
  // Absent: the sand of the border, a cross.
  absent: { backgroundColor: theme.colors.border, borderColor: theme.colors.border },
  glyph: { position: "absolute" as const, top: 2, start: 3 },
  legend: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: theme.spacing.md },
  legendItem: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.xs,
  },
  swatch: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: theme.colors.border,
  },
  keyboard: { gap: theme.spacing.xs },
  keyRow: {
    flexDirection: "row" as const,
    justifyContent: "center" as const,
    gap: theme.spacing.xs,
  },
  key: {
    minHeight: 48,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  wideKey: { flex: 1 },
  srOnly: {
    position: "absolute" as const,
    width: 1,
    height: 1,
    overflow: "hidden" as const,
    opacity: 0,
  },
  enterKey: {
    backgroundColor: theme.colors.primaryAction,
    borderColor: theme.colors.primaryAction,
  },
  keyDisabled: { opacity: 0.5 },
});
