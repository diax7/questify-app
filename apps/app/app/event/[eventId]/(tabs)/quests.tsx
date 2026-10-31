import {
  formatEventTime,
  formatNumber,
  termFor,
  type MemberSponsor,
  type Theme,
} from "@questify/shared";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, Image, Pressable, ScrollView, View } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { Amount } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { EventPill } from "#src/event/EventPill.tsx";
import { FirstBonusRibbon } from "#src/event/FirstBonusRibbon.tsx";
import { PresentedBy } from "#src/event/PresentedBy.tsx";
import { MapsView } from "#src/event/MapsView.tsx";
import { boostLine, flashLine } from "#src/event/flash-boost.ts";
import { forget } from "#src/event/launch.ts";
import { QuestSheet, stateLine } from "#src/event/QuestSheet.tsx";
import type { SponsorLookup } from "#src/event/sponsors.ts";
import { resetLabel } from "#src/event/reset.ts";
import { unlockLine, type CommunityLock } from "#src/event/unlock.ts";
import { useSponsors } from "#src/event/useSponsors.ts";
import type { RunningBoost } from "#src/event/quests-api.ts";
import {
  categoryNotes,
  categorySummary,
  fetchQuests,
  findQuest,
  initiallyOpen,
  ownCommunityLock,
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

/** The brand's lightning (icon-lightning, 128 px), beside a flash quest's badge; decorative, the words say "Flash". */
const LIGHTNING = require("#assets/icons/lightning.png");

/**
 * A flash quest's badge with its end, and a boosted category's "×2" seal with "Double points until …" (T-307). The
 * running ones come from this quest read, never from the live cards, which stop naming them 15 minutes in (CTO 8).
 */
function DropLines({
  quest,
  boost,
  timeZone,
}: Readonly<{
  quest: Pick<Quest, "flash"> | undefined;
  boost: RunningBoost | null;
  timeZone: string;
}>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const flash = quest === undefined ? null : flashLine(quest, t, language, timeZone);
  const boosted = boostLine(boost, t, language, timeZone);
  return (
    <>
      {flash === null ? null : (
        <View style={styles.badgeRow}>
          <Image
            accessibilityElementsHidden
            importantForAccessibility="no"
            source={LIGHTNING}
            resizeMode="contain"
            style={styles.icon}
          />
          <AppText variant="label">{t("quests.flash.badge")}</AppText>
          <AppText muted>{flash}</AppText>
        </View>
      )}
      {boosted === null ? null : (
        <View style={styles.badgeRow}>
          <AppText variant="label" style={styles.seal}>
            {t("quests.boost.badge")}
          </AppText>
          <AppText>{boosted}</AppText>
        </View>
      )}
    </>
  );
}

/**
 * A quest in its category. A quest a community goal locks on its own says which goal opens it (T-306c); one locked
 * with its whole category says only that it opens with the goal, the category's note naming the goal once.
 */
function QuestCard({
  quest,
  sponsor,
  communityLock,
  timeZone,
  onOpen,
}: Readonly<{
  quest: Quest;
  sponsor: MemberSponsor | undefined;
  communityLock: CommunityLock | null;
  timeZone: string;
  onOpen: () => void;
}>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const stateKey = stateLine(quest);
  const unlock =
    quest.state === "locked" && communityLock !== null
      ? unlockLine(communityLock, language, timeZone)
      : null;
  const line =
    unlock === null ? (stateKey === null ? null : t(stateKey)) : t(unlock.key, unlock.values);
  return (
    <Pressable accessibilityRole="button" onPress={onOpen} style={styles.card}>
      <AppText variant="label">{textIn(quest.title, language)}</AppText>
      <Amount amount={formatNumber(quest.points, language)} form="compact" muted />
      <PresentedBy sponsor={sponsor} />
      <DropLines quest={quest} boost={quest.boost} timeZone={timeZone} />
      <FirstBonusRibbon questId={quest.id} bonus={quest.firstBonus} />
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
      {line === null ? null : <AppText>{line}</AppText>}
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
    case "community": {
      const unlock = unlockLine(note.note, language, timeZone);
      return t(unlock.key, unlock.values);
    }
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
  sponsors,
  open,
  timeZone,
  onToggle,
  onOpenQuest,
}: Readonly<{
  category: Category;
  sponsors: SponsorLookup;
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
        <DropLines quest={undefined} boost={category.boost} timeZone={timeZone} />
      </Pressable>
      <PresentedBy sponsor={sponsors.of("category", category.id)} />
      {open
        ? category.quests.map((quest) => (
            <QuestCard
              key={quest.id}
              quest={quest}
              sponsor={sponsors.of("quest", quest.id)}
              communityLock={ownCommunityLock(quest, category)}
              timeZone={timeZone}
              onOpen={() => onOpenQuest(quest.id)}
            />
          ))
        : null}
    </View>
  );
}

/** The categories as a list, each opening and closing on its header. */
function QuestList({
  categories,
  sponsors,
  openIds,
  timeZone,
  onToggle,
  onOpenQuest,
}: Readonly<{
  categories: readonly Category[];
  sponsors: SponsorLookup;
  openIds: readonly string[];
  timeZone: string;
  onToggle: (id: string) => void;
  onOpenQuest: (questId: string) => void;
}>) {
  const { t } = useI18n();
  return (
    <ScrollView contentContainerStyle={{ gap: 16 }}>
      {categories.every((category) => category.quests.length === 0) ? (
        <AppText muted>{t("questsTab.empty")}</AppText>
      ) : null}
      {categories
        .filter((category) => category.quests.length > 0)
        .map((category) => (
          <CategorySection
            key={category.id}
            category={category}
            sponsors={sponsors}
            open={openIds.includes(category.id)}
            timeZone={timeZone}
            onToggle={() => onToggle(category.id)}
            onOpenQuest={onOpenQuest}
          />
        ))}
    </ScrollView>
  );
}

/** The Quests tab's two views of the same quests (FR-826): the list by category, and the event's maps. */
function QuestsViews({
  view,
  onView,
  eventId,
  ...list
}: Readonly<{
  view: "list" | "map";
  onView: (view: "list" | "map") => void;
  eventId: string;
  categories: readonly Category[];
  sponsors: SponsorLookup;
  openIds: readonly string[];
  timeZone: string;
  onToggle: (id: string) => void;
  onOpenQuest: (questId: string) => void;
}>) {
  const { t } = useI18n();
  const { featureOn } = useEvent();
  // The maps switch (T-602): off, there is no toggle and no map, only the list.
  if (!featureOn("maps")) {
    return <QuestList {...list} />;
  }
  return (
    <>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["list", "map"] as const).map((choice) => (
          <Button
            key={choice}
            kind={view === choice ? "primary" : "quiet"}
            selected={view === choice}
            label={t(choice === "list" ? "mapsView.toggleList" : "mapsView.toggleMap")}
            onPress={() => onView(choice)}
          />
        ))}
      </View>
      {view === "map" ? (
        <ScrollView>
          <MapsView eventId={eventId} onOpenQuest={list.onOpenQuest} />
        </ScrollView>
      ) : (
        <QuestList {...list} />
      )}
    </>
  );
}

/** The event's quests (FR-221, FR-222, FR-230, FR-1742; T-114), by category, with each quest's details sheet. */
export default function QuestsScreen() {
  const { t } = useI18n();
  const { eventId } = useEvent();
  const params = useLocalSearchParams<{ quest?: string }>();
  const { answer, load } = useQuests(eventId);
  const sponsors = useSponsors();
  const [openIds, setOpenIds] = useState<string[] | undefined>(undefined);
  const [sheetId, setSheetId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<"list" | "map">("list");
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
        <QuestsViews
          view={view}
          onView={setView}
          eventId={eventId}
          categories={categories ?? []}
          sponsors={sponsors}
          openIds={openIds ?? []}
          timeZone={answer.view.event.timezone}
          onToggle={toggle}
          onOpenQuest={setSheetId}
        />
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
  badgeRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    flexWrap: "wrap" as const,
    gap: theme.spacing.xs,
  },
  icon: { width: 20, height: 20 },
  // A gold wax seal for "×2" (brand deck): the event's highlight on the card.
  seal: {
    paddingHorizontal: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.navigationActive,
    overflow: "hidden" as const,
  },
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
