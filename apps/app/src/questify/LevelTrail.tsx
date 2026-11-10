import Ionicons from "@expo/vector-icons/Ionicons";
import { formatNumber, type Theme } from "@questify/shared";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { Animated, Pressable, View, type LayoutChangeEvent } from "react-native";
import type { Me } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { useReduceMotion } from "#src/components/motion.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { ItemPreview } from "#src/questify/ItemPreview.tsx";
import { previewNamesItem, stoneLabel, type Stone } from "#src/questify/journey.ts";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

const STONE = 40;

/** The glow around the stone of the player's own level; it pulses unless the phone asks for less motion (FR-408). */
function GlowRing() {
  const reduce = useReduceMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  const styles = useThemedStyles(makeStyles);
  useEffect(() => {
    if (reduce !== false) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [reduce, pulse]);
  return <Animated.View pointerEvents="none" style={[styles.glow, { opacity: pulse }]} />;
}

/** The round stone on the trail: the level's number, gold once reached, glowing when it is the player's own. */
function StoneMark({ stone }: Readonly<{ stone: Stone }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.markSlot}
    >
      {stone.state === "current" ? <GlowRing /> : null}
      <View style={[styles.mark, stone.state === "locked" ? styles.markLocked : styles.markGold]}>
        <AppText variant="label" style={stone.state === "locked" ? styles.numberMuted : null}>
          {String(stone.level)}
        </AppText>
      </View>
    </View>
  );
}

/** What ends a stone's card: a gold check once the level is reached, nothing while it is ahead (the item shows a padlock). */
function StoneEnd({ stone }: Readonly<{ stone: Stone }>) {
  const { theme } = useTheme();
  return stone.state === "locked" ? null : (
    <Ionicons
      name="checkmark-circle"
      size={26}
      color={theme.colors.tierGold}
      accessible={false}
      importantForAccessibility="no"
    />
  );
}

/** The picture at the start of a stone's card: the item on the player, or a flag for a level that gives none. */
function StonePicture({ stone, me }: Readonly<{ stone: Stone; me: Me }>) {
  const { theme } = useTheme();
  return stone.item === null ? (
    <Ionicons
      name="flag"
      size={32}
      color={theme.colors.tierGold}
      accessible={false}
      importantForAccessibility="no"
    />
  ) : (
    <ItemPreview item={stone.item} me={me} size={48} locked={stone.state === "locked"} />
  );
}

/** What a stone's card says: the item's name (a title's plate already shows it) and the XP the level starts at. */
function StoneText({ stone }: Readonly<{ stone: Stone }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const item = stone.item;
  return (
    <View style={styles.cardText}>
      {item === null || previewNamesItem(item) ? null : (
        <AppText variant="label" numberOfLines={2}>
          {item.name[language]}
        </AppText>
      )}
      <AppText muted numberOfLines={1}>
        {t("explore.xp", { xp: formatNumber(stone.xpFrom, language) })}
      </AppText>
    </View>
  );
}

function StoneCard({ stone, me }: Readonly<{ stone: Stone; me: Me }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const item = stone.item;
  const open =
    stone.owned && item !== null
      ? () => router.push({ pathname: "/locker", params: { kind: item.kind } })
      : undefined;
  return (
    <Pressable
      accessible
      accessibilityRole={open === undefined ? "text" : "button"}
      accessibilityLabel={stoneLabel(t, language, stone)}
      {...(open === undefined ? {} : { accessibilityHint: t("journey.opensLocker") })}
      onPress={open}
      style={[styles.card, stone.state === "current" ? styles.cardCurrent : null]}
    >
      <StonePicture stone={stone} me={me} />
      <StoneText stone={stone} />
      <StoneEnd stone={stone} />
    </Pressable>
  );
}

/**
 * The level trail: a vertical path of stones, one per level, from the start downwards and aligned to the start side (it
 * mirrors in Arabic). Reached levels show their item in colour with a gold check, the player's own glows, later ones are
 * faded with a padlock. An owned item opens the locker on its tab. `onCurrent` reports where the player's own stone sits.
 */
export function LevelTrail({
  stones,
  me,
  onCurrent,
}: Readonly<{
  stones: readonly Stone[];
  me: Me;
  onCurrent: (event: LayoutChangeEvent) => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      {stones.map((stone, index) => (
        <View
          key={stone.level}
          style={styles.row}
          {...(stone.state === "current" ? { onLayout: onCurrent } : {})}
        >
          <View style={styles.rail}>
            <StoneMark stone={stone} />
            {index === stones.length - 1 ? null : (
              <View style={[styles.line, stone.state === "reached" ? styles.lineGold : null]} />
            )}
          </View>
          <View style={styles.cardSlot}>
            <StoneCard stone={stone} me={me} />
          </View>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  row: { flexDirection: "row" as const, gap: theme.spacing.md },
  rail: { alignItems: "center" as const, width: STONE + 8 },
  markSlot: {
    width: STONE + 8,
    height: STONE + 8,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  mark: {
    width: STONE,
    height: STONE,
    borderRadius: theme.radius.pill,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 3,
    borderColor: theme.colors.navigationBar,
  },
  markGold: { backgroundColor: theme.colors.navigationActive },
  markLocked: { backgroundColor: theme.colors.border, borderColor: theme.colors.border },
  numberMuted: { color: theme.colors.textMuted },
  glow: {
    position: "absolute" as const,
    width: STONE + 8,
    height: STONE + 8,
    borderRadius: theme.radius.pill,
    borderWidth: 4,
    borderColor: theme.colors.highlight,
  },
  line: { flex: 1, width: 4, minHeight: 12, backgroundColor: theme.colors.border },
  lineGold: { backgroundColor: theme.colors.navigationActive },
  cardSlot: { flex: 1, paddingBottom: theme.spacing.md },
  card: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.md,
    minHeight: STONE + 8,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  cardCurrent: { borderColor: theme.colors.highlight, borderWidth: 3 },
  cardText: { flex: 1, minWidth: 72, gap: 2 },
});
