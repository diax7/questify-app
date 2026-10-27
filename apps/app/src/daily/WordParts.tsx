import { Ionicons } from "@expo/vector-icons";
import type { DailyLanguage, Theme } from "@questify/shared";
import { Pressable, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import type { Mark } from "#src/daily/daily-state.ts";
import { gridDirection, KEY_ROWS, tileLetter } from "#src/daily/keyboard.ts";
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

/** The app's own keyboard: every letter of the language, in the language's reading direction. */
export function WordKeyboard({ language, marks, disabled, onLetter, onDelete, onEnter }: KeyProps) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessibilityLabel={t("daily.word.keyboard")} style={styles.keyboard}>
      {KEY_ROWS[language].map((row) => (
        <View key={row.join("")} style={[styles.keyRow, { direction: gridDirection(language) }]}>
          {row.map((letter) => {
            const mark = marks.get(letter) ?? null;
            const shown = tileLetter(language, letter);
            return (
              <Pressable
                key={letter}
                accessibilityRole="button"
                accessibilityLabel={
                  mark === null
                    ? shown
                    : t("daily.word.tile", { letter: shown, mark: t(markLabel(mark)) })
                }
                accessibilityState={{ disabled }}
                disabled={disabled}
                onPress={() => onLetter(letter)}
                style={[styles.key, markStyleOf(styles, mark), disabled && styles.keyDisabled]}
              >
                {mark === null ? null : <MarkGlyph mark={mark} size={10} />}
                <AppText variant="label">{shown}</AppText>
              </Pressable>
            );
          })}
        </View>
      ))}
      <View style={[styles.keyRow, { direction: gridDirection(language) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onEnter}
          style={[styles.key, styles.wideKey, styles.enterKey, disabled && styles.keyDisabled]}
        >
          <AppText variant="label">{t("daily.word.enter")}</AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onDelete}
          style={[styles.key, styles.wideKey, disabled && styles.keyDisabled]}
        >
          <AppText variant="label">{t("daily.word.delete")}</AppText>
        </Pressable>
      </View>
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
  keyRow: { flexDirection: "row" as const, gap: theme.spacing.xs },
  key: {
    flex: 1,
    minHeight: 46,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  wideKey: { flex: 2 },
  enterKey: {
    backgroundColor: theme.colors.primaryAction,
    borderColor: theme.colors.primaryAction,
  },
  keyDisabled: { opacity: 0.5 },
});
