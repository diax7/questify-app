import { ANALYTICS_PANELS, EXPORT_KINDS, exportBodySchema, reportSchema } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readAnalytics, readSponsorTotals, type AnalyticsDeps } from "#src/analytics/analytics";
import { exportStream, readReport, startExport } from "#src/analytics/exports";
import { invalidRequest, notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";

const eventParams = z.object({ eventId: z.uuid() });
const panelParams = eventParams.extend({ panel: z.enum(ANALYTICS_PANELS) });
const sponsorParams = eventParams.extend({ sponsorId: z.uuid() });
const exportParams = eventParams.extend({ kind: z.enum(EXPORT_KINDS) });
const member = { config: { access: "member" }, bodyLimit: 1024 } as const;

/**
 * The event's analytics for the team (T-607, T-608): `GET …/analytics/:panel` the participation, quest and category, or
 * reward and points figures, counts only (FR-1201 to FR-1205); `GET …/analytics/sponsors/:sponsorId` one sponsor's
 * totals with the counts a sponsor may not see left out (FR-1306, FR-1626); `POST …/exports/:kind` a spreadsheet, and
 * `POST …/report` the data of the one-page report, each audited (FR-1206 to FR-1208). Owners and editors within their
 * event limit; another organizer's event, or a sponsor of another event, is 404 and a panel that does not exist is 400.
 */
export function registerAnalyticsTeamRoutes(scope: FastifyInstance, deps: AnalyticsDeps): void {
  scope.get("/events/:eventId/analytics/:panel", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId, panel } = parse(panelParams, request.params);
    const answer = await readAnalytics(deps, organizerContextOf(request), eventId, panel);
    if (answer === undefined) {
      throw notFound();
    }
    return answer;
  });
  scope.get("/events/:eventId/analytics/sponsors/:sponsorId", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId, sponsorId } = parse(sponsorParams, request.params);
    const totals = await readSponsorTotals(deps, organizerContextOf(request), eventId, sponsorId);
    if (totals === undefined) {
      throw notFound();
    }
    return totals;
  });
  scope.post("/events/:eventId/exports/:kind", member, async (request, reply) => {
    const { eventId, kind } = parse(exportParams, request.params);
    const body = parse(exportBodySchema, request.body);
    if ((kind === "sponsor") !== (body.sponsorId !== undefined)) {
      throw invalidRequest();
    }
    const team = organizerContextOf(request);
    const start = await startExport(deps, team, {
      eventId,
      kind,
      sponsorId: body.sponsorId,
      requestId: request.id,
    });
    if (start === undefined) {
      throw notFound();
    }
    return reply
      .header("cache-control", "private, no-store")
      .header("content-disposition", `attachment; filename="${kind}.csv"`)
      .type("text/csv; charset=utf-8")
      .send(
        exportStream(deps, team, {
          eventId,
          kind,
          sponsorId: body.sponsorId,
          language: body.language,
          start,
        }),
      );
  });
  scope.post("/events/:eventId/report", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    const report = await readReport(deps, organizerContextOf(request), {
      eventId,
      requestId: request.id,
    });
    if (report === undefined) {
      throw notFound();
    }
    return reportSchema.parse(report);
  });
}
