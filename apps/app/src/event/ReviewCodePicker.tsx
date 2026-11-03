import { router } from "expo-router";
import { useState } from "react";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import {
  REVIEW_KIND_TEXT,
  fetchReviewCodes,
  fetchReviewMeetCode,
  pickOf,
  type ReviewCode,
} from "#src/event/review-codes.ts";
import { useReviewDemo } from "#src/event/review-demo-flag.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";

type Listing =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "codes"; codes: ReviewCode[] }>
  | Readonly<{ kind: "failed" }>;

/** One line per code: its quest or category, what kind of code it is, and the step's own name. */
function lineOf(
  code: ReviewCode,
  t: ReturnType<typeof useI18n>["t"],
  language: "ar" | "en",
): string {
  const parts = [textIn(code.title, language), t(REVIEW_KIND_TEXT[code.kind])];
  if (code.label !== null) {
    parts.push(textIn(code.label, language));
  }
  return parts.filter((part) => part !== "").join(" · ");
}

/**
 * The App Review demo's code picker (T-710b, FR-303's review half, ADR-565): drawn in the scanner only when Home said
 * the player is the reviewer in the demo event (`useReviewDemo`), and nothing for anyone else. It lists the event's printable codes and hands the picked one to the
 * scanner's own handlers (a meet quest's after asking for a fictional player's fresh code), so every completion rule
 * is the one a real scan meets. No image or gallery picker: the server decides who sees the list.
 */
export function ReviewCodePicker({
  eventId,
  disabled,
  onScan,
}: Readonly<{
  eventId: string;
  disabled: boolean;
  onScan: (read: Readonly<{ data: string }>) => void;
}>) {
  const { t, language } = useI18n();
  const shown = useReviewDemo(eventId);
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);

  const show = async () => {
    setOpen(true);
    setNotice(null);
    setListing({ kind: "loading" });
    const answer = await fetchReviewCodes(api.session, eventId);
    if (answer.kind === "signed_out") {
      router.replace("/home");
      return;
    }
    setListing(answer.kind === "codes" ? answer : { kind: "failed" });
  };

  const pick = async (code: ReviewCode) => {
    const chosen = pickOf(code);
    if (chosen === undefined) {
      return;
    }
    if (chosen.kind === "scan") {
      setOpen(false);
      onScan({ data: chosen.data });
      return;
    }
    const meet = await fetchReviewMeetCode(api.session, eventId, chosen.questId);
    if (meet.kind === "signed_out") {
      router.replace("/home");
    } else if (meet.kind === "code") {
      setOpen(false);
      onScan({ data: meet.code });
    } else {
      setNotice(t(meet.kind === "none_left" ? "scanner.review.noneLeft" : "scanner.review.failed"));
    }
  };

  if (!shown) {
    return null;
  }
  return (
    <>
      <Button
        kind="quiet"
        label={t("scanner.review.pick")}
        disabled={disabled}
        onPress={() => void show()}
      />
      <Sheet visible={open} title={t("scanner.review.title")} onClose={() => setOpen(false)}>
        <AppText muted>{t("scanner.review.body")}</AppText>
        {listing.kind === "loading" ? <AppText muted>{t("common.loading")}</AppText> : null}
        {listing.kind === "failed" ? (
          <AppText accessibilityRole="alert">{t("scanner.review.failed")}</AppText>
        ) : null}
        {listing.kind === "codes" && listing.codes.length === 0 ? (
          <AppText>{t("scanner.review.empty")}</AppText>
        ) : null}
        {notice === null ? null : <AppText accessibilityRole="alert">{notice}</AppText>}
        {listing.kind === "codes"
          ? listing.codes.map((code) => (
              <Button
                key={`${code.kind}:${code.id}`}
                kind="quiet"
                label={lineOf(code, t, language)}
                onPress={() => void pick(code)}
              />
            ))
          : null}
      </Sheet>
    </>
  );
}
