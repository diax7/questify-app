import type { Theme } from "@questify/shared";
import type { Ref } from "react";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import type { RecapView } from "#src/event/recap.ts";
import { StampEmblem } from "#src/questify/PassportSection.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The recap card (FR-752, ADR-339): the event, the rank, the quests done and the souvenirs, and nothing else; no
 * username, score, balance, link or code. It is a passport stamp grown into a card (CLAUDE.md principle 4): a wood
 * frame around a parchment panel with a gold edge, the stamp's gold-ringed emblem, and gold-edged souvenir chips, all
 * from the theme's roles and no new art. The view behind `cardRef` is what the phone draws into the shared image, so
 * it keeps its own background and does not collapse (`collapsable={false}`; Android drops a layout-only view).
 */
export function RecapCard({ view, cardRef }: Readonly<{ view: RecapView; cardRef: Ref<View> }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      ref={cardRef}
      collapsable={false}
      accessible
      accessibilityLabel={view.summary}
      style={styles.frame}
    >
      <View style={styles.panel}>
        <StampEmblem letter={view.emblem} />
        <AppText variant="title" style={styles.center}>
          {view.title}
        </AppText>
        <AppText muted style={styles.center}>
          {view.where}
        </AppText>
        {view.rank === null ? null : (
          <AppText variant={view.rank.kind === "final" ? "display" : "label"} style={styles.center}>
            {view.rank.text}
          </AppText>
        )}
        <AppText style={styles.center}>{view.quests}</AppText>
        {view.souvenirs === null ? null : (
          <View style={styles.souvenirs}>
            <AppText variant="label" style={styles.center}>
              {view.souvenirs.heading}
            </AppText>
            <View style={styles.chips}>
              {view.souvenirs.names.map((name, index) => (
                <View key={`${index}:${name}`} style={styles.chip}>
                  <AppText variant="label">{name}</AppText>
                </View>
              ))}
              {view.souvenirs.more === null ? null : (
                <View style={styles.chip}>
                  <AppText variant="label">{view.souvenirs.more}</AppText>
                </View>
              )}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  frame: {
    padding: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.navigationBar,
  },
  panel: {
    alignItems: "center" as const,
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
    borderRadius: theme.radius.md,
    borderWidth: 3,
    borderColor: theme.colors.navigationActive,
    backgroundColor: theme.colors.background,
  },
  center: { textAlign: "center" as const },
  souvenirs: { alignItems: "center" as const, gap: theme.spacing.sm },
  chips: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    justifyContent: "center" as const,
    gap: theme.spacing.sm,
  },
  chip: {
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.surface,
  },
});
