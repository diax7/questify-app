import type { Theme } from "@questify/shared";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import { AppText } from "#src/components/AppText.tsx";
import { useOpen } from "#src/event/HomeBlocks.tsx";
import type { ContactRow, FaqRow, PartView } from "#src/event/info-page.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The organizer's About text (T-613): plain text, line breaks kept, nothing in it tappable. */
export function AboutSection({ text }: Readonly<{ text: string }>) {
  const { t } = useI18n();
  return (
    <>
      <AppText variant="title" accessibilityRole="header">
        {t("eventInfo.aboutTitle")}
      </AppText>
      <AppText>{text}</AppText>
    </>
  );
}

/** The questions and their answers, in the order the organizer set. */
export function FaqSection({ rows }: Readonly<{ rows: readonly FaqRow[] }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <AppText variant="title" accessibilityRole="header">
        {t("eventInfo.faq")}
      </AppText>
      {rows.map((row) => (
        <View key={row.question} style={styles.entry}>
          <AppText variant="label">{row.question}</AppText>
          <AppText>{row.answer}</AppText>
        </View>
      ))}
    </>
  );
}

function ContactButton({ row }: Readonly<{ row: ContactRow }>) {
  const { t } = useI18n();
  const open = useOpen();
  const styles = useThemedStyles(makeStyles);
  const [failed, setFailed] = useState(false);
  const press = () => {
    if (row.target.kind === "link") {
      open(row.target);
      return;
    }
    setFailed(false);
    Linking.openURL(row.target.url).catch(() => setFailed(true));
  };
  return (
    <View style={styles.entry}>
      <Pressable accessibilityRole="link" onPress={press} style={styles.contact}>
        <AppText variant="label">{row.label}</AppText>
        <AppText>{isolatedLtr(row.value)}</AppText>
      </Pressable>
      {failed ? <AppText accessibilityRole="alert">{t("eventInfo.contactFailed")}</AppText> : null}
    </View>
  );
}

/** The ways to reach the organizer: an email address, a phone number or a website, each one tap away. */
export function ContactsSection({ rows }: Readonly<{ rows: readonly ContactRow[] }>) {
  const { t } = useI18n();
  return (
    <>
      <AppText variant="title" accessibilityRole="header">
        {t("eventInfo.contacts")}
      </AppText>
      {rows.map((row) => (
        <ContactButton key={`${row.label}:${row.value}`} row={row} />
      ))}
    </>
  );
}

function ListPart({ items }: Readonly<{ items: readonly string[] }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.entry}>
      {items.map((item, index) => (
        // The items are plain lines with no id and keep their order, so the position is their identity.
        // oxlint-disable-next-line react/no-array-index-key
        <View key={`${index}:${item}`} style={styles.item}>
          <AppText>{"•"}</AppText>
          <AppText style={styles.itemText}>{item}</AppText>
        </View>
      ))}
    </View>
  );
}

/** One part of the extra page: a heading, a paragraph, a list, or a link that asks before it leaves the app. */
export function PagePart({ part }: Readonly<{ part: PartView }>) {
  const open = useOpen();
  const styles = useThemedStyles(makeStyles);
  switch (part.kind) {
    case "heading":
      return (
        <AppText variant="title" accessibilityRole="header">
          {part.text}
        </AppText>
      );
    case "text":
      return <AppText>{part.text}</AppText>;
    case "list":
      return <ListPart items={part.items} />;
    default:
      return (
        <Pressable
          accessibilityRole="link"
          onPress={() => open({ kind: "link", url: part.url, host: part.host })}
          style={styles.contact}
        >
          <AppText variant="label">{part.label}</AppText>
        </Pressable>
      );
  }
}

const makeStyles = (theme: Theme) => ({
  entry: { gap: theme.spacing.xs },
  contact: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  item: { flexDirection: "row" as const, gap: theme.spacing.sm },
  itemText: { flex: 1 },
});
