import type { Pool, QueryResultRow } from "pg";
import { MESSAGES } from "@questify/shared";
import { notFound, notEnrolled } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { HttpError } from "#src/http-error";

const ERROR_MESSAGES: Readonly<Record<string, { ar: string; en: string }>> = {
  invalid_announcement: MESSAGES["error.invalidAnnouncement"],
  announcement_already_sent: MESSAGES["error.announcementAlreadySent"],
  announcement_limit: MESSAGES["error.announcementLimit"],
  announcement_nobody: MESSAGES["error.announcementNobody"],
  announcement_event_closed: MESSAGES["error.announcementEventClosed"],
  announcement_event_not_live: MESSAGES["error.announcementEventNotLive"],
  announcement_unavailable: MESSAGES["error.announcementUnavailable"],
};

export type AnnouncementDeps = Readonly<{ pool: Pool }>;

export async function announcementCall<Row extends QueryResultRow>(
  deps: AnnouncementDeps,
  context: RequestContext,
  sql: string,
  values: readonly unknown[],
): Promise<Row> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, context, async () => {
        const result = await client.query<Row>(sql, [...values]);
        return result.rows[0] as Row;
      }),
    );
  } catch (error) {
    const { code, detail } = error as { code?: string; detail?: string };
    if (code === "AN404") throw notFound();
    if (code === "AM403") throw notEnrolled();
    const refusals: Record<string, readonly [number, string]> = {
      PA422: [422, "invalid_announcement"],
      PA409: [409, "announcement_already_sent"],
      PL429: [429, "announcement_limit"],
      PT409: [409, "announcement_nobody"],
      PE409: [409, `announcement_${detail}`],
    };
    const refusal = refusals[code ?? ""];
    if (refusal === undefined) throw error;
    const [status, name] = refusal;
    throw announcementError(
      status,
      name,
      code === "PL429" ? { window: detail } : { issue: detail },
    );
  }
}

export function announcementError(
  status: number,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): HttpError {
  const message = ERROR_MESSAGES[code];
  return new HttpError(status, code, message ?? MESSAGES["announcements.page.loadFailed"], details);
}
