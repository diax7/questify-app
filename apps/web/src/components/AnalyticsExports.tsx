"use client";

import { type ExportKind, type Language, type MessageKey } from "@questify/shared";
import { useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { downloadBlob } from "#src/lib/download-text.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { infoTip } from "#src/ui/info.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";

const PLAYER_FILES = [
  "players",
  "completions",
  "redemptions",
  "submissions",
  "surveys",
] as const satisfies readonly ExportKind[];

const LABELS: Readonly<Record<ExportKind, MessageKey>> = {
  players: "analytics.export.players",
  completions: "analytics.export.completions",
  redemptions: "analytics.export.redemptions",
  submissions: "analytics.export.submissions",
  surveys: "analytics.export.surveys",
  sponsor: "analytics.export.sponsor",
};

/**
 * Asks the API for one file and hands it to the browser. The API audits the export and writes the file in pieces; the
 * answer is read as a blob so the byte-order mark Excel needs for Arabic reaches the file. Resolves to whether it worked.
 */
async function saveExport(
  eventApi: string,
  kind: ExportKind,
  language: Language,
  sponsorId: string,
): Promise<"saved" | "signed_out" | "failed"> {
  try {
    const response = await fetch(`${eventApi}/exports/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sponsorId === "" ? { language } : { language, sponsorId }),
    });
    if (response.status === 401) {
      return "signed_out";
    }
    if (!response.ok) {
      return "failed";
    }
    downloadBlob(`${kind}.csv`, await response.blob());
    return "saved";
  } catch {
    return "failed";
  }
}

/**
 * The spreadsheets of the event (FR-1206, FR-1306, FR-1626): five files while all sponsors are shown, and a sponsor's
 * totals (no player) once one sponsor is chosen. Each is audited by the API.
 */
export function ExportsSection({
  language,
  eventApi,
  sponsorId,
}: Readonly<{ language: Language; eventApi: string; sponsorId: string }>) {
  const t = useTranslator(language);
  const [working, setWorking] = useState<ExportKind | null>(null);
  const [failed, setFailed] = useState(false);
  const files: readonly ExportKind[] = sponsorId === "" ? PLAYER_FILES : ["sponsor"];
  const start = async (kind: ExportKind) => {
    setWorking(kind);
    setFailed(false);
    const result = await saveExport(eventApi, kind, language, sponsorId);
    setWorking(null);
    if (result === "signed_out") {
      window.location.assign(`/${language}/sign-in?ended=1`);
    }
    setFailed(result === "failed");
  };
  return (
    <Section
      level={2}
      title={t("analytics.export.title")}
      info={infoTip(t, "analytics.export.hint")}
    >
      {failed ? (
        <Notice tone="danger" role="alert">
          {t("analytics.export.failed")}
        </Notice>
      ) : null}
      <Toolbar label={t("analytics.export.title")}>
        {files.map((kind) => (
          <Button
            key={kind}
            variant="secondary"
            disabled={working !== null}
            onClick={() => void start(kind)}
          >
            {t(LABELS[kind])}
          </Button>
        ))}
      </Toolbar>
    </Section>
  );
}
