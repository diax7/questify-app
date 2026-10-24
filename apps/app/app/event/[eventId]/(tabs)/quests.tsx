import { formatEventTime, formatNumber, termFor, type Theme } from "@questify/shared";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, ScrollView, View } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { Amount } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { EventPill } from "#src/event/EventPill.tsx";
import { forget } from "#src/event/launch.ts";
import { QuestSheet, stateLine } from "#src/event/QuestSheet.tsx";
import { resetLabel } from "#src/event/reset.ts";
import {
  categoryNotes,
  categorySummary,
  fetchQuests,
  findQuest,
  initiallyOpen,
  type Category,
  type CategoryNote,
  type CompletionAnswer,
  type Quest,
  type QuestsAnswer,
} from "#src/event/quests-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * Reads the quests on focus and when the app returns to the front. A definite 403 `not_enrolled` or 404 forgets the
 * event and goes to Questify home; a pending member waits; a network failure keeps the last good copy.
 */
function useQuests(eventId: string) {
  const [answer, setAnswer] = useState<QuestsAnswer | undefined>(undefined);
  const load = useCallback(async () => {
    const loaded = await fetchQuests(api.session, eventId);
    if (loaded.kind === "gone") {
      await forget(keyValueStore, eventId);
      router.replace("/home");
      return;
    }
    if (loaded.kind === "signed_out") {
      router.replace("/home");
      return;
    }
    setAnswer((current) =>
      loaded.kind === "network" && current?.kind === "quests" ? current : loaded,
    );
  }, [eventId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // A vote from the live poll card pays over this tab, so focus never changes (T-306).
  const { paidCount } = useEvent();
  useEffect(() => {
    if (paidCount > 0) {
      void load();
    }
  }, [paidCount, load]);
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void load();
      }
    });
    return () => watcher.remove();
  }, [load]);
  return { answer, load };
}

function QuestCard({
  quest,
  timeZone,
  onOpen,
}: Readonly<{ quest: Quest; timeZone: string; onOpen: () => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const line = stateLine(quest);
  return (
    <Pressable accessibilityRole="button" onPress={onOpen} style={styles.card}>
      <AppText variant="label">{textIn(quest.title, language)}</AppText>
      <Amount amount={formatNumber(quest.points, language)} form="compact" muted />
      {quest.item === null ? null : (
        <AppText muted>{t("questsTab.itemReward", { item: textIn(quest.item, language) })}</AppText>
      )}
      {quest.repeatCap > 1 ? (
        <AppText muted>{t("questsTab.repeat", { done: quest.done, cap: quest.repeatCap })}</AppText>
      ) : null}
      {quest.steps === null || quest.state === "done" ? null : (
        <AppText muted>
          {t("questsTab.passport", {
            done: formatNumber(quest.steps.done, language),
            needed: formatNumber(quest.steps.needed, language),
          })}
        </AppText>
      )}
      {quest.state === "not_yet" && quest.opensAt !== null ? (
        <AppText muted>
          {t("quests.opens", {
            time: formatEventTime(new Date(quest.opensAt), timeZone, language),
          })}
        </AppText>
      ) : null}
      {line === null ? null : <AppText>{t(line)}</AppText>}
    </Pressable>
  );
}

/** A category header's note in words (T-304): its opening time, its unlock, its order, its reset, its bonus. */
function noteText(
  note: CategoryNote,
  t: ReturnType<typeof useI18n>["t"],
  language: "ar" | "en",
  timeZone: string,
): string {
  switch (note.kind) {
    case "opens":
      return t("questsTab.category.opens", {
        time: formatEventTime(new Date(note.at), timeZone, language),
      });
    case "unlockAfter":
      return t("questsTab.category.unlockAfter", { name: textIn(note.name, language) });
    case "inOrder":
      return t("questsTab.category.inOrder");
    case "bonus":
      return t("questsTab.category.bonus", { points: formatNumber(note.points, language) });
    case "bonusEarned":
      return t("questsTab.category.bonusEarned", { points: formatNumber(note.points, language) });
    case "bonusItem":
      return t("questsTab.category.bonusItem", { item: textIn(note.name, language) });
    case "resets": {
      const label = resetLabel(note, Date.now(), language);
      return t(label.key, label.values);
    }
  }
}

/** One category: a header that opens and closes it, with its summary (FR-230), its rules (T-304), and its quests. */
function CategorySection({
  category,
  open,
  timeZone,
  onToggle,
  onOpenQuest,
}: Readonly<{
  category: Category;
  open: boolean;
  timeZone: string;
  onToggle: () => void;
  onOpenQuest: (questId: string) => void;
}>) {
  const { t, language, rtl } = useI18n();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  const summary = categorySummary(category);
  // A closed category's arrow points along the reading direction.
  const arrow = open ? "▾" : rtl ? "◂" : "▸";
  const summaryText = t("questsTab.summary", {
    currency: termFor(terms.currency, language, summary.available),
    earned: formatNumber(summary.earned, language),
    available: formatNumber(summary.available, language),
    finished: summary.finished,
    total: summary.total,
  });
  const name = textIn(category.name, language);
  const notes = categoryNotes(category).map((note) => noteText(note, t, language, timeZone));
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={[name, summaryText, ...notes].join(", ")}
        onPress={onToggle}
        style={styles.header}
      >
        <AppText variant="title">
          {arrow} {name}
        </AppText>
        {open ? null : <AppText muted>{summaryText}</AppText>}
        {notes.map((note) => (
          <AppText key={note} muted>
            {note}
          </AppText>
        ))}
      </Pressable>
      {open
        ? category.quests.map((quest) => (
            <QuestCard
              key={quest.id}
              quest={quest}
              timeZone={timeZone}
              onOpen={() => onOpenQuest(quest.id)}
            />
          ))
        : null}
    </View>
  );
}

/** The event's quests (FR-221, FR-222, FR-230, FR-1742; T-114), by category, with each quest's details sheet. */
export default function QuestsScreen() {
  const { t } = useI18n();
  const { eventId } = useEvent();
  const params = useLocalSearchParams<{ quest?: string }>();
  const { answer, load } = useQuests(eventId);
  const [openIds, setOpenIds] = useState<string[] | undefined>(undefined);
  const [sheetId, setSheetId] = useState<string | undefined>(undefined);
  const categories = answer?.kind === "quests" ? answer.view.categories : undefined;

  useEffect(() => {
    if (categories !== undefined && openIds === undefined) {
      setOpenIds(initiallyOpen(categories, params.quest));
    }
  }, [categories, openIds, params.quest]);

  // Home's Go names a quest: open it once per value; the param is cleared when its sheet closes.
  useEffect(() => {
    const target = params.quest;
    if (categories === undefined || target === undefined) {
      return;
    }
    const holder = categories.find((category) => category.quests.some((q) => q.id === target));
    if (holder !== undefined) {
      setOpenIds((current) => [...new Set([...(current ?? []), holder.id])]);
      setSheetId(target);
    }
  }, [categories, params.quest]);

  const closeSheet = useCallback(() => {
    setSheetId(undefined);
    router.setParams({ quest: undefined });
  }, []);
  // A quest that left the list (hidden, deleted) takes its sheet with it, so it never reopens unasked.
  useEffect(() => {
    if (categories !== undefined && sheetId !== undefined && !findQuest(categories, sheetId)) {
      closeSheet();
    }
  }, [categories, sheetId, closeSheet]);
  const completed = (outcome: CompletionAnswer) => {
    if (outcome.kind === "reload") {
      closeSheet();
    }
    const changed = ["completed", "reload", "limit", "not_open"];
    if (changed.includes(outcome.kind)) {
      void load();
    }
  };
  const toggle = (id: string) =>
    setOpenIds((current = []) =>
      current.includes(id) ? current.filter((open) => open !== id) : [...current, id],
    );

  return (
    <Screen title={t("nav.quests")} header={<EventPill />}>
      {answer === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
      {answer?.kind === "pending" ? <AppText>{t("eventHome.pending")}</AppText> : null}
      {answer?.kind === "network" ? (
        <>
          <AppText accessibilityRole="alert">{t("questsTab.loadFailed")}</AppText>
          <Button label={t("common.retry")} onPress={() => void load()} />
        </>
      ) : null}
      {answer?.kind === "quests" ? (
        <ScrollView contentContainerStyle={{ gap: 16 }}>
          {categories?.every((category) => category.quests.length === 0) ? (
            <AppText muted>{t("questsTab.empty")}</AppText>
          ) : null}
          {(categories ?? [])
            .filter((category) => category.quests.length > 0)
            .map((category) => (
              <CategorySection
                key={category.id}
                category={category}
                open={openIds?.includes(category.id) ?? false}
                timeZone={answer.view.event.timezone}
                onToggle={() => toggle(category.id)}
                onOpenQuest={setSheetId}
              />
            ))}
        </ScrollView>
      ) : null}
      {answer?.kind === "quests" && sheetId !== undefined ? (
        <QuestSheet
          key={sheetId}
          quest={findQuest(answer.view.categories, sheetId)}
          timeZone={answer.view.event.timezone}
          onClose={closeSheet}
          onCompleted={completed}
          onSent={() => void load()}
        />
      ) : null}
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  section: { gap: theme.spacing.sm },
  header: {
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.sm,
  },
  card: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
