import type { Theme } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { ticketStatusKey, type MyTicket } from "#src/event/help.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** One request: its kind, quest, text, where it stands, and the reply signed "The event team" (never a person). */
function RequestCard({ ticket, withEvent }: Readonly<{ ticket: MyTicket; withEvent: boolean }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.card} testID={`request-${ticket.id}`}>
      <View style={styles.row}>
        {ticket.unread ? (
          <View accessible accessibilityLabel={t("help.unread")} style={styles.dot} />
        ) : null}
        <AppText variant="label">{t(`help.kind.${ticket.kind}`)}</AppText>
        <AppText muted>{t(ticketStatusKey(ticket))}</AppText>
      </View>
      {withEvent && ticket.event !== null ? (
        <AppText muted>{textIn(ticket.event.name, language)}</AppText>
      ) : null}
      {ticket.quest === null ? null : (
        <AppText muted>
          {t("help.aboutQuest", { quest: textIn(ticket.quest.title, language) })}
        </AppText>
      )}
      <AppText>{ticket.text}</AppText>
      {ticket.reply === null ? null : (
        <View style={styles.reply}>
          <AppText variant="label">{t("help.replyFrom")}</AppText>
          <AppText>{ticket.reply}</AppText>
        </View>
      )}
      {ticket.status === "closed" ? <AppText muted>{t("help.newRequest")}</AppText> : null}
    </View>
  );
}

/** Your requests (FR-338): newest first; in the profile each one names its event. */
export function RequestList({
  tickets,
  withEvent = false,
}: Readonly<{ tickets: readonly MyTicket[]; withEvent?: boolean }>) {
  const { t } = useI18n();
  return (
    <>
      <AppText variant="title">{t("help.mine")}</AppText>
      {tickets.length === 0 ? <AppText muted>{t("help.none")}</AppText> : null}
      {tickets.map((ticket) => (
        <RequestCard key={ticket.id} ticket={ticket} withEvent={withEvent} />
      ))}
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  row: { flexDirection: "row" as const, gap: theme.spacing.sm, alignItems: "center" as const },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.primaryAction,
  },
  reply: {
    gap: theme.spacing.xs,
    paddingTop: theme.spacing.sm,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
  },
});
