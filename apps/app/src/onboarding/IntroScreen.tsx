import { Ionicons } from "@expo/vector-icons";
import {
  DEFAULT_COMPOSED_PLAYER_INTRO,
  type IntroCardKey,
  type Language,
  type Theme,
} from "@questify/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BackHandler, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { LANGUAGE_OPTIONS } from "#src/i18n/language.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { IntroArt } from "#src/onboarding/IntroArt.tsx";
import {
  destinationFor,
  hasLanguageStep,
  introCards,
  variantFromParams,
  type Destination,
  type Ending,
  type IntroCard,
  type IntroVariant,
} from "#src/onboarding/intro-flow.ts";
import { resolveIntroOrder } from "#src/onboarding/intro-order.ts";
import { readIntroState, writeIntroState, type IntroState } from "#src/onboarding/intro-state.ts";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

type RouteParams = { replay?: string; event?: string; name?: string };

type Flow = Readonly<{
  variant: IntroVariant;
  onLanguage: boolean;
  /** The cards' order is still being read, so no card shows yet. */
  waiting: boolean;
  cards: readonly IntroCard[];
  index: number;
  chosen: Language;
  busy: boolean;
  choose: (next: Language) => void;
  confirmLanguage: () => void;
  next: () => void;
  back: () => void;
  finish: (ending: Ending) => void;
}>;

function goTo(destination: Destination): void {
  if (destination === "back") {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/home");
    }
    return;
  }
  router.replace(destination.replace);
  if (destination.after !== undefined) {
    router.push(destination.after);
  }
}

/** The intro's stored step, read once; undefined while the phone is still answering. */
function useStoredStep(): IntroState | undefined {
  const [stored, setStored] = useState<IntroState | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void readIntroState(keyValueStore).then((state) => {
      if (live) {
        setStored(state);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return stored;
}

/**
 * The cards to play, in the platform's order (T-802b): the last working copy at once, else the fresh configuration if it
 * arrives in a moment, else the shipped order. Read once, so the cards never change under the player. Undefined while the
 * phone is still answering.
 */
function useIntroOrder(): readonly IntroCardKey[] | undefined {
  const [order, setOrder] = useState<readonly IntroCardKey[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void resolveIntroOrder({ client: api.client, store: keyValueStore }).then((resolved) => {
      if (live) {
        setOrder(resolved);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return order;
}

/**
 * The intro's steps and endings. The language step saves the choice (and restarts the app when it changed, ADR-110),
 * the first card marks the intro seen so it shows once per install (FR-1802), and every ending goes where
 * `destinationFor` says. Nothing but that one flag is stored (FR-1800).
 */
function useIntroFlow(
  variant: IntroVariant,
  stored: IntroState,
  order: readonly IntroCardKey[] | undefined,
): Flow {
  const { language, switchLanguage } = useI18n();
  const [languageDone, setLanguageDone] = useState(false);
  const [chosen, choose] = useState<Language>(language);
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState(0);
  const cards = useMemo(
    () => introCards(variant, order ?? DEFAULT_COMPOSED_PLAYER_INTRO.cards),
    [variant, order],
  );
  const onLanguage = hasLanguageStep(variant, languageDone || stored === "language");
  const waiting = order === undefined;

  useEffect(() => {
    if (!onLanguage && !waiting && variant.kind !== "replay") {
      void writeIntroState(keyValueStore, "seen");
    }
  }, [onLanguage, waiting, variant.kind]);

  const confirmLanguage = useCallback(async () => {
    setBusy(true);
    await writeIntroState(keyValueStore, "language");
    if (chosen === language) {
      setLanguageDone(true);
    } else {
      try {
        await switchLanguage(chosen);
      } catch {
        // The language could not be saved, so the app stays as it is and the cards follow in the current language.
        setLanguageDone(true);
      }
    }
    setBusy(false);
  }, [chosen, language, switchLanguage]);

  const next = useCallback(() => setIndex((at) => Math.min(at + 1, cards.length - 1)), [cards]);
  const back = useCallback(() => setIndex((at) => Math.max(at - 1, 0)), []);
  const finishing = useRef(false);
  const finish = useCallback(
    async (ending: Ending) => {
      if (finishing.current) {
        return;
      }
      finishing.current = true;
      if (variant.kind !== "replay") {
        await writeIntroState(keyValueStore, "seen");
      }
      goTo(destinationFor(variant, ending));
    },
    [variant],
  );

  useEffect(() => {
    const watcher = BackHandler.addEventListener("hardwareBackPress", () => {
      if (onLanguage || index === 0) {
        return false;
      }
      back();
      return true;
    });
    return () => watcher.remove();
  }, [onLanguage, index, back]);

  return {
    variant,
    onLanguage,
    waiting,
    cards,
    index,
    chosen,
    busy,
    choose,
    confirmLanguage: () => void confirmLanguage(),
    next,
    back,
    finish: (ending) => void finish(ending),
  };
}

/** A wooden frame around a parchment panel with a gold rim: the deck's material language (ADR-013). */
function Panel({ children }: Readonly<{ children: ReactNode }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.frame}>
      <View style={styles.panel}>{children}</View>
    </View>
  );
}

function LanguageStep({ flow }: Readonly<{ flow: Flow }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <ScrollView style={styles.stage} contentContainerStyle={styles.stageContent}>
        <Panel>
          <AppText variant="display" accessibilityRole="header" style={styles.centered}>
            {t("onboarding.language.title")}
          </AppText>
          <View style={styles.options}>
            {LANGUAGE_OPTIONS.map((option) => {
              const selected = option.code === flow.chosen;
              return (
                <Pressable
                  key={option.code}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => flow.choose(option.code)}
                  style={[styles.option, selected && styles.optionSelected]}
                >
                  <AppText variant="title">{option.name}</AppText>
                </Pressable>
              );
            })}
          </View>
          {flow.chosen === language ? null : (
            <AppText muted style={styles.centered}>
              {t("settings.restartBody")}
            </AppText>
          )}
        </Panel>
      </ScrollView>
      <View style={styles.footer}>
        <Button label={t("common.continue")} disabled={flow.busy} onPress={flow.confirmLanguage} />
      </View>
    </>
  );
}

/** Progress dots: the current one is a gold bar. They follow the reading direction. */
function Dots({ count, index }: Readonly<{ count: number; index: number }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      accessible
      accessibilityLabel={t("onboarding.progress", { current: index + 1, total: count })}
      style={styles.dots}
    >
      {Array.from({ length: count }, (_unused, at) => (
        <View key={at} style={[styles.dot, at === index && styles.dotCurrent]} />
      ))}
    </View>
  );
}

/** The last card's two ways on: scan an event QR (or, right after a join, go to the event) and Explore events. */
function FinalActions({
  variant,
  onEnd,
}: Readonly<{ variant: IntroVariant; onEnd: (ending: Ending) => void }>) {
  const { t } = useI18n();
  const joined = variant.kind === "joined";
  return (
    <>
      <Button
        label={t(joined ? "joinCard.openEvent" : "onboarding.scan")}
        onPress={() => onEnd(joined ? "event" : "scan")}
      />
      <Button kind="quiet" label={t("onboarding.explore")} onPress={() => onEnd("explore")} />
    </>
  );
}

function CardsStep({ flow }: Readonly<{ flow: Flow }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const card = flow.cards[flow.index];
  if (card === undefined) {
    return null;
  }
  const last = flow.index === flow.cards.length - 1;
  return (
    <>
      <ScrollView style={styles.stage} contentContainerStyle={styles.stageContent}>
        <Panel>
          <IntroArt key={flow.index} art={card.art} />
          <AppText
            variant="display"
            accessibilityRole="header"
            accessibilityLiveRegion="polite"
            style={styles.centered}
          >
            {t(card.title, card.params)}
          </AppText>
          <AppText style={styles.centered}>{t(card.body, card.params)}</AppText>
        </Panel>
      </ScrollView>
      <View style={styles.footer}>
        <Dots count={flow.cards.length} index={flow.index} />
        {last ? (
          <FinalActions variant={flow.variant} onEnd={flow.finish} />
        ) : (
          <Button label={t("onboarding.next")} onPress={flow.next} />
        )}
      </View>
    </>
  );
}

/** Back on the cards after the first, and Skip on every step (FR-1799). */
function TopBar({ flow }: Readonly<{ flow: Flow }>) {
  const { t, rtl } = useI18n();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const canGoBack = !flow.onLanguage && flow.index > 0;
  return (
    <View style={styles.top}>
      {canGoBack ? (
        <Pressable accessibilityRole="button" onPress={flow.back} style={styles.topButton}>
          <Ionicons
            name={rtl ? "chevron-forward" : "chevron-back"}
            size={22}
            color={theme.colors.text}
          />
          <AppText variant="label">{t("common.back")}</AppText>
        </Pressable>
      ) : (
        <View />
      )}
      <Pressable
        accessibilityRole="button"
        onPress={() => flow.finish("skip")}
        style={styles.topButton}
      >
        <AppText variant="label">{t("onboarding.skip")}</AppText>
      </Pressable>
    </View>
  );
}

function IntroSteps({
  variant,
  stored,
  order,
}: Readonly<{
  variant: IntroVariant;
  stored: IntroState;
  order: readonly IntroCardKey[] | undefined;
}>) {
  const flow = useIntroFlow(variant, stored, order);
  return (
    <>
      <TopBar flow={flow} />
      {flow.onLanguage ? <LanguageStep flow={flow} /> : null}
      {flow.onLanguage || flow.waiting ? null : <CardsStep flow={flow} />}
    </>
  );
}

/**
 * The player's intro (FR-1798 to FR-1802): a language choice on the first launch, then the story cards (four unless the
 * platform hid some or reordered them, FR-1803), each with a Skip. From Settings the same cards replay; right after
 * joining from a join link they name the event. It asks for no permission and sends nothing about the player anywhere:
 * its one request is the anonymous read of the public configuration that holds the cards' order (ADR-611).
 */
export function IntroScreen() {
  const { replay, event, name } = useLocalSearchParams<RouteParams>();
  const { rtl } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const variant = useMemo(() => variantFromParams({ replay, event, name }), [replay, event, name]);
  const stored = useStoredStep();
  const order = useIntroOrder();
  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.page}>
      <View style={[styles.content, { direction: rtl ? "rtl" : "ltr" }]}>
        {stored === undefined ? null : (
          <IntroSteps variant={variant} stored={stored} order={order} />
        )}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.background },
  content: { flex: 1, paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.lg },
  top: {
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    alignItems: "center" as const,
    minHeight: 52,
  },
  topButton: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.xs,
    minHeight: 44,
    paddingHorizontal: theme.spacing.xs,
  },
  stage: { flex: 1 },
  stageContent: { flexGrow: 1, justifyContent: "center" as const },
  frame: {
    alignSelf: "stretch" as const,
    borderRadius: theme.radius.lg + 6,
    backgroundColor: theme.colors.navigationBar,
    padding: 6,
  },
  panel: {
    alignItems: "center" as const,
    gap: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.navigationActive,
    backgroundColor: theme.colors.surface,
    paddingVertical: theme.spacing.xxl,
    paddingHorizontal: theme.spacing.xl,
  },
  centered: { textAlign: "center" as const },
  options: { flexDirection: "row" as const, gap: theme.spacing.md, alignSelf: "stretch" as const },
  option: {
    flex: 1,
    alignItems: "center" as const,
    paddingVertical: theme.spacing.lg,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  optionSelected: { borderColor: theme.colors.primaryAction, borderWidth: 3 },
  footer: { minHeight: 156, gap: theme.spacing.md, paddingTop: theme.spacing.lg },
  dots: {
    flexDirection: "row" as const,
    justifyContent: "center" as const,
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.border },
  dotCurrent: { width: 28, backgroundColor: theme.colors.navigationActive },
});
