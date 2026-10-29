"use client";

import type { Language, OrganizerAlertSwitches, OrganizerAlertType } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import {
  ALERT_LABELS,
  ALERT_ORDER,
  readAlertSwitches,
  withAlertSwitch,
} from "#src/lib/organizer-alerts.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/**
 * The signed-in member's own email-alert switches (T-503, FR-1727): one box per alert type, saved as soon as a box
 * changes. Owners and editors alike see only their own choices; the API takes no member id, so no one sets another
 * member's. It says plainly that sending is not switched on yet (ADR-360).
 */
export function OrganizerAlertSwitchesPanel({
  language,
  organizerId,
}: Readonly<{ language: Language; organizerId: string }>) {
  const t = translatorFor(language);
  const path = `/v1/organizers/${organizerId}/alerts/me`;
  const [switches, setSwitches] = useState<OrganizerAlertSwitches | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const fail = useCallback(
    (body: unknown) => {
      const code = errorCodeOf(body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      setProblem(describeProblem(body, language, t).text);
    },
    [language, t],
  );

  useEffect(() => {
    void (async () => {
      const result = await requestJson("GET", path);
      const read = result.ok ? readAlertSwitches(result.body) : undefined;
      if (read === undefined) {
        fail(result.body);
        return;
      }
      setSwitches(read);
    })();
  }, [path, fail]);

  const change = async (type: OrganizerAlertType, on: boolean) => {
    if (switches === null) return;
    const before = switches;
    const wanted = withAlertSwitch(before, type, on);
    setSwitches(wanted);
    setBusy(true);
    setProblem(null);
    setSaved(false);
    const result = await requestJson("PUT", path, wanted);
    setBusy(false);
    const stored = result.ok ? readAlertSwitches(result.body) : undefined;
    if (stored === undefined) {
      setSwitches(before);
      fail(result.body);
      return;
    }
    setSwitches(stored);
    setSaved(true);
  };

  return (
    <section className={styles.panel} aria-labelledby="alerts-title">
      <h2 id="alerts-title" className={styles.subtitle}>
        {t("alerts.title")}
      </h2>
      <p className={styles.muted}>{t("alerts.hint")}</p>
      <p className={styles.muted}>{t("alerts.notLive")}</p>
      {switches === null ? (
        <p className={styles.muted}>{t("common.loading")}</p>
      ) : (
        <ul className={styles.list}>
          {ALERT_ORDER.map((type) => (
            <li key={type}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={switches[type]}
                  disabled={busy}
                  onChange={(changed) => void change(type, changed.target.checked)}
                />
                <span>{t(ALERT_LABELS[type])}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {saved ? (
        <p role="status" className={styles.notice}>
          {t("alerts.saved")}
        </p>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
    </section>
  );
}
