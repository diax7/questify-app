import { Ionicons } from "@expo/vector-icons";
import {
  formatNumber,
  type BannerSlide,
  type CountdownCard,
  type FeaturedTarget,
  type QuickLink,
  type QuickLinkIcon,
  type TextCard,
  type Theme,
} from "@questify/shared";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Linking, PanResponder, Pressable, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { Amount } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { useReduceMotion, useScreenReader } from "#src/components/motion.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { useLive } from "#src/event/LiveContext.tsx";
import type { RankingAnswer } from "#src/event/home-api.ts";
import {
  SLIDE_MS,
  countdownRefreshMs,
  countdownView,
  featuredView,
  localIn,
  nextSlide,
  showDots,
  slideLabel,
  swipeStep,
  tapOutcome,
  type FeaturedView,
  type TapOutcome,
} from "#src/event/home-content.ts";
import { fetchQuests, type QuestsView } from "#src/event/quests-api.ts";
import { fetchShop, type ShopView } from "#src/event/shop-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

/** Opens where a tap leads: a screen, one quest, or a web link after the player agrees to leave the app. */
function useOpen(): (outcome: TapOutcome) => void {
  const { t } = useI18n();
  const { eventId } = useEvent();
  return useCallback(
    (outcome) => {
      switch (outcome.kind) {
        case "agenda":
        case "maps":
          router.push(`/event/${eventId}/${outcome.kind}`);
          break;
        case "shop":
          router.navigate({ pathname: "/event/[eventId]/rewards", params: { eventId } });
          break;
        case "quest":
          router.navigate({
            pathname: "/event/[eventId]/quests",
            params: { eventId, quest: outcome.questId },
          });
          break;
        case "link":
          Alert.alert(t("home.link.title"), t("home.link.body", { host: outcome.host }), [
            { text: t("common.cancel"), style: "cancel" },
            {
              text: t("home.link.open"),
              onPress: () => void Linking.openURL(outcome.url).catch(() => undefined),
            },
          ]);
          break;
      }
    },
    [eventId, t],
  );
}

function SlideFace({ slide, label }: Readonly<{ slide: BannerSlide; label: string | undefined }>) {
  const { language } = useI18n();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const subtitle = localIn(slide.subtitle, language);
  return (
    <View style={styles.slide} accessible accessibilityLabel={label}>
      <AppText variant="title" style={{ color: theme.colors.onPrimaryAction }}>
        {localIn(slide.title, language)}
      </AppText>
      {subtitle === "" ? null : (
        <AppText style={{ color: theme.colors.onPrimaryAction }}>{subtitle}</AppText>
      )}
    </View>
  );
}

/**
 * The banner (FR-1829): one slide as a plain banner, several as a slider that moves on every few seconds, by a swipe or
 * by the dots. It stands still when the phone asks for reduced motion and after the player has touched it. A slide with a tap
 * action is a button; one with none is just a picture of words.
 */
export function BannerBlock({ slides }: Readonly<{ slides: readonly BannerSlide[] }>) {
  const { t, language, rtl } = useI18n();
  const { featureOn } = useEvent();
  const reduceMotion = useReduceMotion();
  const screenReader = useScreenReader();
  const open = useOpen();
  const styles = useThemedStyles(makeStyles);
  const [index, setIndex] = useState(0);
  const [touched, setTouched] = useState(false);
  const count = slides.length;
  const current = Math.min(index, count - 1);
  const go = useCallback(
    (step: 1 | -1) => {
      setTouched(true);
      setIndex((value) => nextSlide(value, count, step));
    },
    [count],
  );
  useEffect(() => {
    if (!showDots(count) || reduceMotion !== false || screenReader !== false || touched) {
      return;
    }
    const timer = setInterval(() => setIndex((value) => nextSlide(value, count, 1)), SLIDE_MS);
    return () => clearInterval(timer);
  }, [count, reduceMotion, screenReader, touched]);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, drag) =>
          Math.abs(drag.dx) > 12 && Math.abs(drag.dx) > Math.abs(drag.dy),
        onPanResponderRelease: (_event, drag) => {
          const step = swipeStep(drag.dx, rtl);
          if (step !== 0) {
            go(step);
          }
        },
      }),
    [go, rtl],
  );
  const slide = slides[current];
  if (slide === undefined) {
    return null;
  }
  const outcome = tapOutcome(slide.action, featureOn);
  const label = showDots(count)
    ? slideLabel(t("home.banner.slideOf", { n: current + 1, total: count }), slide, language)
    : undefined;
  return (
    <View style={styles.banner} {...responder.panHandlers}>
      {outcome === null ? (
        <SlideFace slide={slide} label={label} />
      ) : (
        <Pressable accessibilityRole="button" onPress={() => open(outcome)}>
          <SlideFace slide={slide} label={label} />
        </Pressable>
      )}
      {showDots(count) ? (
        <View style={styles.dots}>
          {slides.map((_slide, position) => (
            <Pressable
              // The slides have no id and keep their order, so the position is their identity.
              // oxlint-disable-next-line react/no-array-index-key
              key={position}
              accessibilityRole="button"
              accessibilityLabel={t("home.banner.goTo", { n: position + 1 })}
              accessibilityState={{ selected: position === current }}
              hitSlop={12}
              onPress={() => {
                setTouched(true);
                setIndex(position);
              }}
              style={[styles.dot, position === current && styles.dotActive]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const ICONS: Readonly<Record<QuickLinkIcon, keyof typeof Ionicons.glyphMap>> = {
  calendar: "calendar-outline",
  map: "map-outline",
  gift: "gift-outline",
  trophy: "trophy-outline",
  star: "star-outline",
  compass: "compass-outline",
  bolt: "flash-outline",
  info: "information-circle-outline",
};

/** A row of buttons (FR-1828); one that leads to a screen whose switch is off is left out. */
export function QuickLinksBlock({ links }: Readonly<{ links: readonly QuickLink[] }>) {
  const { language } = useI18n();
  const { featureOn } = useEvent();
  const { theme } = useTheme();
  const open = useOpen();
  const styles = useThemedStyles(makeStyles);
  const shown = links.flatMap((link) => {
    const outcome = tapOutcome(link.action, featureOn);
    return outcome === null ? [] : [{ link, outcome }];
  });
  if (shown.length === 0) {
    return null;
  }
  return (
    <View style={styles.links}>
      {shown.map(({ link, outcome }) => (
        <Pressable
          key={`${link.icon}:${localIn(link.label, language)}`}
          accessibilityRole="button"
          onPress={() => open(outcome)}
          style={styles.link}
        >
          <Ionicons name={ICONS[link.icon]} size={24} color={theme.colors.text} />
          <AppText variant="label" numberOfLines={2} style={styles.linkLabel}>
            {localIn(link.label, language)}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

/** The quest or reward the organizer featured, read from the player's own lists (FR-1828); nothing when it is not there. */
export function FeaturedBlock({ target }: Readonly<{ target: FeaturedTarget }>) {
  const { t, language } = useI18n();
  const { eventId, featureOn } = useEvent();
  const open = useOpen();
  const styles = useThemedStyles(makeStyles);
  const [quests, setQuests] = useState<QuestsView | undefined>(undefined);
  const [shop, setShop] = useState<ShopView | undefined>(undefined);
  const shopOn = featureOn("shop");
  useEffect(() => {
    let current = true;
    if (target.kind === "quest") {
      void fetchQuests(api.session, eventId).then((answer) => {
        if (current && answer.kind === "quests") setQuests(answer.view);
      });
    } else if (shopOn) {
      void fetchShop(api.session, eventId).then((answer) => {
        if (current && answer.kind === "shop") setShop(answer.view);
      });
    }
    return () => {
      current = false;
    };
  }, [eventId, shopOn, target.kind]);
  const view: FeaturedView | null = featuredView(target, quests, shopOn ? shop : undefined);
  if (view === null) {
    return null;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        open(view.kind === "quest" ? { kind: "quest", questId: view.id } : { kind: "shop" })
      }
      style={styles.card}
    >
      <AppText variant="title">{t("home.featured.title")}</AppText>
      <AppText variant="label">{textIn(view.title, language)}</AppText>
      <Amount amount={formatNumber(view.points, language)} form="labelled" muted />
    </Pressable>
  );
}

const PODIUM_HEIGHT = [56, 80, 44] as const;

/** The top three as a podium (FR-1828), second place left of first as on a real one; a tap opens the full ranking. */
export function PodiumBlock({
  eventId,
  ranking,
}: Readonly<{ eventId: string; ranking: RankingAnswer }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (ranking.kind !== "ranking" || ranking.ranking.rows.length === 0) {
    return null;
  }
  const top = ranking.ranking.rows.slice(0, 3);
  // Second, first, third: the order a podium is built in. The row's own rank names the step, so a tie keeps its number.
  const steps = [top[1], top[0], top[2]].map((row, place) => ({
    row,
    height: PODIUM_HEIGHT[place],
  }));
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/event/${eventId}/ranking`)}
      style={styles.card}
    >
      <AppText variant="title">{t("nav.ranking")}</AppText>
      <View style={styles.podium}>
        {steps.map(({ row, height }) =>
          row === undefined ? (
            <View key={`empty:${height}`} style={styles.step} />
          ) : (
            <View key={`${row.rank}:${row.username}`} style={styles.step}>
              <Avatar name={row.avatar} username={row.username} size={36} />
              <AppText numberOfLines={1} style={{ writingDirection: "ltr" }}>
                @{row.username}
              </AppText>
              {row.score === null ? null : (
                <AppText variant="label">{formatNumber(row.score, language)}</AppText>
              )}
              <View style={[styles.block, { height }]}>
                <AppText variant="title">{row.rank}</AppText>
              </View>
            </View>
          ),
        )}
      </View>
    </Pressable>
  );
}

/** The organizer's text card (FR-1828): plain text in the player's language; nothing in it is tappable. */
export function TextCardBlock({ card }: Readonly<{ card: TextCard }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const title = localIn(card.title, language);
  return (
    <View style={styles.card}>
      {title === "" ? null : <AppText variant="title">{title}</AppText>}
      <AppText>{localIn(card.body, language)}</AppText>
    </View>
  );
}

/** A countdown card (FR-1830): the time left, then at zero its message or nothing. */
export function CountdownBlock({ card }: Readonly<{ card: CountdownCard }>) {
  const { t, language } = useI18n();
  const { clockOffsetMs } = useLive();
  const styles = useThemedStyles(makeStyles);
  const [phoneNow, setPhoneNow] = useState(() => Date.now());
  const now = phoneNow + clockOffsetMs;
  const wait = countdownRefreshMs(card, now);
  useEffect(() => {
    if (wait === null) {
      return;
    }
    const timer = setTimeout(() => setPhoneNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [wait, phoneNow]);
  const view = countdownView(card, now, language);
  if (view.kind === "hidden") {
    return null;
  }
  return (
    <View style={styles.card} accessibilityLiveRegion={view.kind === "message" ? "polite" : "none"}>
      <AppText variant="title">{view.label}</AppText>
      {view.kind === "message" ? (
        <AppText>{view.message}</AppText>
      ) : (
        <AppText variant="label">{view.span ?? t("home.countdown.soon")}</AppText>
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  banner: { gap: theme.spacing.sm },
  slide: {
    gap: theme.spacing.xs,
    minHeight: 120,
    justifyContent: "center" as const,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primaryAction,
  },
  dots: {
    flexDirection: "row" as const,
    justifyContent: "center" as const,
    gap: theme.spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.border,
  },
  dotActive: { backgroundColor: theme.colors.primaryAction },
  links: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: theme.spacing.sm },
  link: {
    flexGrow: 1,
    flexBasis: "30%" as const,
    alignItems: "center" as const,
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  linkLabel: { textAlign: "center" as const },
  podium: {
    flexDirection: "row" as const,
    alignItems: "flex-end" as const,
    gap: theme.spacing.sm,
  },
  step: { flex: 1, alignItems: "center" as const, gap: theme.spacing.xs },
  block: {
    alignSelf: "stretch" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderTopLeftRadius: theme.radius.sm,
    borderTopRightRadius: theme.radius.sm,
    backgroundColor: theme.colors.highlight,
  },
});
