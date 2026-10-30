import {
  CHEER_EMOJI,
  CHEER_NAME_KEYS,
  CHEER_REACTIONS,
  type CheerReaction,
  type Theme,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { momentIsOn, secondsToWait, sendCheer } from "#src/event/cheers.ts";
import { clockText } from "#src/event/polls.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Notice = "failed" | "over" | null;

/** The phone's clock, each second while the moment runs, so the time left counts down and a wait ends on time. */
function useSecondClock(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The cheer button on the event's Home (T-509, FR-1841), shown only while the owner's cheers moment is live: five fixed
 * reactions, no text. Over the per-minute limit the buttons rest for the seconds the API names. A moment that ended or a
 * lost connection says so in one line and never blocks anything else.
 */
export function CheersBar({ eventId, endsAt }: Readonly<{ eventId: string; endsAt: string }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const now = useSecondClock();
  const [slowUntil, setSlowUntil] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const wait = secondsToWait(slowUntil, now);

  const send = useCallback(
    async (reaction: CheerReaction) => {
      setNotice(null);
      const answer = await sendCheer(api.session, eventId, reaction);
      if (answer.kind === "slow") setSlowUntil(Date.now() + answer.seconds * 1000);
      else if (answer.kind === "over") setNotice("over");
      else if (answer.kind === "network") setNotice("failed");
    },
    [eventId],
  );

  if (!momentIsOn(endsAt, now)) return null;
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <AppText variant="title">{t("cheers.prompt")}</AppText>
      <AppText variant="label" muted>
        {t("cheers.endsIn", { time: clockText((Date.parse(endsAt) - now) / 1000) })}
      </AppText>
      <View style={styles.row}>
        {CHEER_REACTIONS.map((reaction) => (
          <Pressable
            key={reaction}
            accessibilityRole="button"
            accessibilityLabel={t(CHEER_NAME_KEYS[reaction])}
            accessibilityState={{ disabled: wait > 0 }}
            disabled={wait > 0}
            onPress={() => void send(reaction)}
            style={[styles.reaction, wait > 0 ? styles.resting : null]}
          >
            <AppText style={styles.emoji}>{CHEER_EMOJI[reaction]}</AppText>
          </Pressable>
        ))}
      </View>
      {wait > 0 ? (
        <AppText variant="label">{t("cheers.slow", { seconds: String(wait) })}</AppText>
      ) : null}
      {notice === null ? null : (
        <AppText variant="label" accessibilityRole="alert">
          {t(notice === "over" ? "cheers.over" : "cheers.failed")}
        </AppText>
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
  row: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    justifyContent: "space-between" as const,
    gap: theme.spacing.sm,
  },
  reaction: {
    minWidth: 56,
    minHeight: 56,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  resting: { opacity: 0.4 },
  emoji: { fontSize: 28, lineHeight: 36 },
});
