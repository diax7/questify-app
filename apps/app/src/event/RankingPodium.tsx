import { formatNumber, type Theme } from "@questify/shared";
import { Pressable, View } from "react-native";
import { CurrencyIcon } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import {
  podiumMetrics,
  podiumPlaces,
  type PodiumMetrics,
  type ShownRow,
} from "#src/event/ranking.ts";
import { useEvent } from "#src/event/EventContext.tsx";
import { RowName, pressOf, useRowLabel } from "#src/event/RankingRows.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

type StepColor = "tierSilver" | "tierGold" | "tierBronze";

/** The step's colour by where it stands: second, first, third (silver, gold, bronze, the achievement rings' colours). */
const STEP_COLORS: readonly StepColor[] = ["tierSilver", "tierGold", "tierBronze"];

/** One standing place: the face, the player, the score when the row has one, and the step with the place on it. */
function Place({
  row,
  slot,
  face,
  stepHeight,
  rankText,
  scoreLine,
}: Readonly<{
  row: ShownRow;
  slot: 0 | 1 | 2;
  face: number;
  stepHeight: number;
  rankText: PodiumMetrics["rankText"];
  scoreLine: boolean;
}>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const label = useRowLabel(row);
  const { eventId } = useEvent();
  return (
    <Pressable
      accessible
      accessibilityRole={row.hidden ? "text" : "button"}
      accessibilityLabel={label}
      onPress={pressOf(row, eventId)}
      style={styles.place}
    >
      <View style={row.isMe ? [styles.ring, { borderRadius: face }] : styles.noRing}>
        <Avatar name={row.avatar} username={row.username} size={face} equipment={row.equipment} />
      </View>
      <RowName row={row} variant="label" style={styles.name} />
      {scoreLine ? (
        <View style={styles.score}>
          {row.score === null ? null : (
            <>
              <CurrencyIcon size={16} />
              <AppText variant="label" numberOfLines={1}>
                {formatNumber(row.score, language)}
              </AppText>
            </>
          )}
        </View>
      ) : null}
      <StepBlock
        rank={row.rank}
        slot={slot}
        height={stepHeight}
        rankText={rankText}
        isMe={row.isMe}
      />
    </Pressable>
  );
}

function StepBlock({
  rank,
  slot,
  height,
  rankText,
  isMe,
}: Readonly<{
  rank: number;
  slot: 0 | 1 | 2;
  height: number;
  rankText: PodiumMetrics["rankText"];
  isMe: boolean;
}>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[
        styles.step,
        { height },
        styles[STEP_COLORS[slot] ?? "tierGold"],
        isMe ? styles.stepMine : null,
      ]}
    >
      <AppText variant={rankText} numberOfLines={1} adjustsFontSizeToFit style={styles.rank}>
        {rank}
      </AppText>
    </View>
  );
}

/**
 * The top three on a podium (FR-1832), second place on one side of first and third on the other, in `height` points. A
 * place nobody holds yet is left empty so the others keep their steps. With the event on places only there is no score
 * line, and the steps take its room.
 */
export function Podium({
  top,
  height,
  withScores,
}: Readonly<{ top: readonly ShownRow[]; height: number; withScores: boolean }>) {
  const styles = useThemedStyles(makeStyles);
  const { face, steps, rankText } = podiumMetrics(height, withScores);
  const places = podiumPlaces(top);
  return (
    <View accessibilityRole="summary" style={[styles.podium, { height }]} testID="ranking-podium">
      {places.map((row, index) => {
        const slot = index as 0 | 1 | 2;
        return row === undefined ? (
          <View key={`empty:${slot}`} style={styles.place} />
        ) : (
          <Place
            key={row.key}
            row={row}
            slot={slot}
            face={face}
            stepHeight={steps[slot]}
            rankText={rankText}
            scoreLine={withScores}
          />
        );
      })}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  podium: {
    flexDirection: "row" as const,
    alignItems: "flex-end" as const,
    gap: theme.spacing.sm,
  },
  // Every place shares the row's width, so a long username shrinks inside its own column.
  place: { flex: 1, alignItems: "center" as const, justifyContent: "flex-end" as const },
  ring: { borderWidth: 3, borderColor: theme.colors.highlight, padding: 1 },
  noRing: { padding: 4 },
  name: { alignSelf: "stretch" as const, textAlign: "center" as const },
  score: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: theme.spacing.xs,
    minHeight: 18,
  },
  step: {
    alignSelf: "stretch" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderTopLeftRadius: theme.radius.md,
    borderTopRightRadius: theme.radius.md,
    // A thicker lower edge gives the step the raised look of the deck's wooden blocks.
    borderBottomWidth: 4,
    borderColor: theme.colors.border,
  },
  stepMine: { borderColor: theme.colors.highlight, borderWidth: 3 },
  rank: { color: theme.colors.surface },
  tierSilver: { backgroundColor: theme.colors.tierSilver },
  tierGold: { backgroundColor: theme.colors.tierGold },
  tierBronze: { backgroundColor: theme.colors.tierBronze },
});
