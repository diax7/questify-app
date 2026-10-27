import type { Theme } from "@questify/shared";
import type { Ref } from "react";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import type { RecapView } from "#src/event/recap.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The recap card (FR-752, ADR-339): the event, the rank, the quests done and the souvenirs, and nothing else; no
 * username, score, balance, link or code. The view behind `cardRef` is what the phone draws into the shared image, so
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
      style={styles.card}
    >
      <AppText variant="title">{view.title}</AppText>
      <AppText muted>{view.where}</AppText>
      {view.rank === null ? null : (
        <AppText variant={view.rank.kind === "final" ? "display" : "label"}>
          {view.rank.text}
        </AppText>
      )}
      <AppText>{view.quests}</AppText>
      {view.souvenirs === null ? null : (
        <View style={styles.souvenirs}>
          <AppText variant="label">{view.souvenirs.heading}</AppText>
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
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
    borderRadius: theme.radius.lg,
    borderWidth: 4,
    borderColor: theme.colors.highlight,
    backgroundColor: theme.colors.background,
  },
  souvenirs: { gap: theme.spacing.sm },
  chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: theme.spacing.sm },
  chip: {
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
