import { REPORT_NOTE_MAX, REPORT_REASONS, type ReportReason } from "@questify/shared";
import { useState } from "react";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field } from "#src/components/Controls.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { sendReport, type ReportOutcome, type ReportSubject } from "#src/questify/report-api.ts";

/**
 * Report on any quest, reward, announcement, session, sponsor, event page, profile or ranking row (FR-1411,
 * STORE_COMPLIANCE 1.2, T-705b): a reason, an optional note, Send. The player is thanked and told nothing more (no
 * outcome notice in v1); the report goes to Questify's queue, and a username reported in an event to its team too.
 */
export function ReportButton({ subject }: Readonly<{ subject: ReportSubject }>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReportOutcome | null>(null);
  const close = () => {
    setOpen(false);
    setReason(null);
    setNote("");
    setOutcome(null);
  };
  const send = async (chosen: ReportReason) => {
    setBusy(true);
    setOutcome(await sendReport(api.session, subject, chosen, note));
    setBusy(false);
  };
  const told: Readonly<Record<ReportOutcome, string>> = {
    sent: t("contentReport.thanks"),
    limit: t("contentReport.limit"),
    failed: t("contentReport.failed"),
  };
  return (
    <>
      <Button kind="quiet" label={t("contentReport.action")} onPress={() => setOpen(true)} />
      <Sheet visible={open} title={t("contentReport.title")} onClose={close}>
        {outcome === "sent" ? (
          <AppText accessibilityLiveRegion="polite">{told.sent}</AppText>
        ) : (
          <>
            {REPORT_REASONS.map((one) => (
              <Button
                key={one}
                kind="quiet"
                label={t(`reports.reason.${one}`)}
                selected={reason === one}
                onPress={() => setReason(one)}
              />
            ))}
            <Field
              label={t("contentReport.details")}
              value={note}
              maxLength={REPORT_NOTE_MAX}
              multiline
              onChangeText={setNote}
            />
            <Button
              label={t("contentReport.send")}
              disabled={busy || reason === null}
              onPress={() => {
                if (reason !== null) {
                  void send(reason);
                }
              }}
            />
            {outcome === null ? null : (
              <AppText accessibilityLiveRegion="polite">{told[outcome]}</AppText>
            )}
          </>
        )}
      </Sheet>
    </>
  );
}
