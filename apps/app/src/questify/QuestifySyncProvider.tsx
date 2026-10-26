import type { Language, QuestifySync, Theme } from "@questify/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { PopIn } from "#src/components/motion.tsx";
import { usePlayer } from "#src/auth/player.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import type { Translate } from "#src/i18n/words.ts";
import { onCompletion } from "#src/questify/completion-signal.ts";
import type { LevelUp } from "#src/questify/level.ts";
import { fetchAchievements, postSync } from "#src/questify/questify-api.ts";
import { syncNotices, wroteSomething } from "#src/questify/sync-notices.ts";
import {
  createSyncScheduler,
  type RunOutcome,
  type SyncScheduler,
} from "#src/questify/sync-scheduler.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

const TOAST_MS = 5000;

type SyncValue = Readonly<{
  /** Profile or Questify quests gained focus: ask the server to credit what the player earned. */
  syncNow: () => void;
  /** Counts the syncs that wrote something, so a screen reads its data again after one. */
  version: number;
}>;

const SyncContext = createContext<SyncValue>({ syncNow: () => undefined, version: 0 });

export const useQuestifySync = (): SyncValue => useContext(SyncContext);

type Words = Readonly<{ t: Translate; language: Language }>;

/**
 * Keeps achievements, Questify quests and levels credited (T-403): the scheduler decides when to call the server, this
 * shows the result as light toasts and the level-up beat, and tells the screens to read their data again.
 */
export function QuestifySyncProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { state, reload } = usePlayer();
  const { t, language } = useI18n();
  const signedIn = state.status === "signed_in";
  const [version, setVersion] = useState(0);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [levelUp, setLevelUp] = useState<LevelUp | null>(null);
  const scheduler = useRef<SyncScheduler | null>(null);
  const words = useRef<Words>({ t, language });
  words.current = { t, language };

  const present = useCallback(
    async (sync: QuestifySync) => {
      const catalog = sync.achievements.length === 0 ? null : await fetchAchievements(api.session);
      const lines = syncNotices(sync, catalog, words.current.t, words.current.language);
      setNotices((current) => [...current, ...lines]);
      if (sync.levelUp !== null) {
        setLevelUp(sync.levelUp);
      }
      setVersion((current) => current + 1);
      // XP and the level on the profile come from the profile read.
      if (sync.quests.length > 0 || sync.levelUp !== null) void reload();
    },
    [reload],
  );

  useEffect(() => {
    if (!signedIn) return;
    const run = async (): Promise<RunOutcome> => {
      const outcome = await postSync(api.session);
      if (outcome.kind === "limited") {
        return { kind: "limited", retryAfterSeconds: outcome.retryAfterSeconds };
      }
      if (outcome.kind === "ok" && wroteSomething(outcome.sync)) await present(outcome.sync);
      return { kind: "done" };
    };
    const made = createSyncScheduler({
      run,
      now: Date.now,
      setTimer: (work, ms) => setTimeout(work, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    scheduler.current = made;
    const stopCompletions = onCompletion(made.completion);
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") made.foreground();
    });
    // Launch and sign-in count as a return to the foreground.
    made.foreground();
    return () => {
      stopCompletions();
      appState.remove();
      made.stop();
      scheduler.current = null;
    };
  }, [signedIn, present]);

  const dismissNotice = useCallback(() => setNotices((current) => current.slice(1)), []);
  const dismissLevelUp = useCallback(() => setLevelUp(null), []);
  const syncNow = useCallback(() => scheduler.current?.focus(), []);
  const value = useMemo<SyncValue>(() => ({ syncNow, version }), [syncNow, version]);
  return (
    <SyncContext.Provider value={value}>
      <View style={styles.fill}>
        <View
          style={styles.fill}
          accessibilityElementsHidden={levelUp !== null}
          importantForAccessibility={levelUp === null ? "auto" : "no-hide-descendants"}
        >
          {children}
        </View>
        <SyncNotices
          notices={notices}
          levelUp={levelUp}
          dismissNotice={dismissNotice}
          dismissLevelUp={dismissLevelUp}
        />
      </View>
    </SyncContext.Provider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  layer: { position: "absolute", inset: 0 },
});

type NoticesProps = Readonly<{
  notices: readonly string[];
  levelUp: LevelUp | null;
  dismissNotice: () => void;
  dismissLevelUp: () => void;
}>;

/** One light toast at a time (it goes by itself after a few seconds), and the level-up card over the screen. */
function SyncNotices({ notices, levelUp, dismissNotice, dismissLevelUp }: NoticesProps) {
  const { t, language } = useI18n();
  const insets = useSafeAreaInsets();
  const themed = useThemedStyles(makeStyles);
  const first = notices[0];
  useEffect(() => {
    if (first === undefined) return;
    const timer = setTimeout(dismissNotice, TOAST_MS);
    return () => clearTimeout(timer);
  }, [first, notices.length, dismissNotice]);
  return (
    <View pointerEvents="box-none" style={styles.layer}>
      {first === undefined ? null : (
        <Pressable
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          accessibilityLabel={first}
          accessibilityHint={t("common.close")}
          onPress={dismissNotice}
          style={[themed.toast, { bottom: insets.bottom + 24 }]}
        >
          <AppText variant="label">{first}</AppText>
        </Pressable>
      )}
      {levelUp === null ? null : (
        <View style={themed.backdrop} accessibilityViewIsModal>
          <View style={themed.levelCard}>
            <PopIn>
              <AppText variant="title">{t("level.up")}</AppText>
              <AppText variant="display">{t("level.number", { level: levelUp.level })}</AppText>
              <AppText variant="title">{levelUp.title[language]}</AppText>
              {levelUp.items?.map((item) => (
                <AppText key={item.id}>{item.name[language]}</AppText>
              ))}
              <Button label={t("common.continue")} onPress={dismissLevelUp} />
            </PopIn>
          </View>
        </View>
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  toast: {
    position: "absolute" as const,
    start: theme.spacing.xl,
    end: theme.spacing.xl,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.surface,
  },
  backdrop: {
    position: "absolute" as const,
    inset: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: theme.spacing.xl,
    backgroundColor: "rgba(59, 38, 16, 0.55)",
  },
  levelCard: {
    alignSelf: "stretch" as const,
    padding: theme.spacing.xl,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.surface,
  },
});
