import { REPORT_KINDS, type ReportKind } from "@questify/shared";
import { notFound } from "next/navigation";
import { ConsoleReport } from "#src/components/ConsoleReport.tsx";
import { isEventId } from "#src/lib/console.ts";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; kind: string; targetId: string }> }>;

const isReportKind = (kind: string): kind is ReportKind =>
  (REPORT_KINDS as readonly string[]).includes(kind);

/** One reported item and its actions (T-705b, FR-1404, FR-1414). Platform admins only. */
export default async function ConsoleReportPage({ params }: Props) {
  const { lang, kind, targetId } = await params;
  const page = await consolePage(lang);
  if (!isReportKind(kind) || !isEventId(targetId)) {
    notFound();
  }
  return <ConsoleReport language={page.language} kind={kind} targetId={targetId} />;
}
