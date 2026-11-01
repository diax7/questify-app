import { ANALYTICS_PANELS, EXPORT_KINDS, exportBodySchema, reportSchema } from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readAnalytics, readSponsorTotals, type AnalyticsDeps } from "#src/analytics/analytics";
import { createExportGate, type ExportGate } from "#src/analytics/export-gate";
import { exportStream, readReport, recordReportPrint, startExport } from "#src/analytics/exports";
import { exportRunning, invalidRequest, notFound, tooManyExports } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import type { OrganizerContext } from "#src/organizers/store";

const eventParams = z.object({ eventId: z.uuid() });
const panelParams = eventParams.extend({ panel: z.enum(ANALYTICS_PANELS) });
const sponsorParams = eventParams.extend({ sponsorId: z.uuid() });
const exportParams = eventParams.extend({ kind: z.enum(EXPORT_KINDS) });
const member = { config: { access: "member" }, bodyLimit: 1024 } as const;

/**
 * Counts a start against the staff member's allowance, or answers 429 with the wait. Answers how to take the count
 * back for a start that found no event.
 */
function admitStart(gate: ExportGate, team: OrganizerContext, reply: FastifyReply): () => void {
  const turn = gate.admit(team.staffUserId);
  if (!turn.admitted) {
    reply.header("retry-after", String(turn.retryAfterSeconds));
    throw tooManyExports();
  }
  return turn.refund;
}

/**
 * A spreadsheet: one export of an event at a time and a limit on starts per staff member, both answered 429 before the
 * audit entry is written. The event's slot is given back when the file has gone out, or the download is cut off.
 */
async function sendExport(
  deps: AnalyticsDeps,
  gate: ExportGate,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { eventId, kind } = parse(exportParams, request.params);
  const body = parse(exportBodySchema, request.body);
  if ((kind === "sponsor") !== (body.sponsorId !== undefined)) {
    throw invalidRequest();
  }
  const team = organizerContextOf(request);
  const release = gate.claim(team.organizerId, eventId);
  if (release === undefined) {
    throw exportRunning();
  }
  try {
    const refund = admitStart(gate, team, reply);
    const start = await startExport(deps, team, {
      eventId,
      kind,
      sponsorId: body.sponsorId,
      requestId: request.id,
    });
    if (start === undefined) {
      refund();
      throw notFound();
    }
    const file = exportStream(deps, team, {
      eventId,
      kind,
      sponsorId: body.sponsorId,
      language: body.language,
      start,
    });
    file.once("close", release);
    return reply
      .header("cache-control", "private, no-store")
      .header("content-disposition", `attachment; filename="${kind}.csv"`)
      .type("text/csv; charset=utf-8")
      .send(file);
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * The event's analytics for the team (T-607, T-608): `GET …/analytics/:panel` the participation, quest and category, or
 * reward and points figures, counts only (FR-1201 to FR-1205); `GET …/analytics/sponsors/:sponsorId` one sponsor's
 * totals with the counts a sponsor may not see left out (FR-1306, FR-1626); `POST …/exports/:kind` a spreadsheet,
 * `GET …/report` the data of the one-page report, and `POST …/report` the audit entry of printing it (FR-1206 to
 * FR-1208). A spreadsheet runs one at a time per event, and starts are limited per staff member: 429, no audit entry.
 * Owners and editors within their event limit; another organizer's event, or a sponsor of another event, is 404 and a
 * panel that does not exist is 400.
 */
export function registerAnalyticsTeamRoutes(scope: FastifyInstance, deps: AnalyticsDeps): void {
  const gate = createExportGate();
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
  scope.post("/events/:eventId/exports/:kind", member, (request, reply) =>
    sendExport(deps, gate, request, reply),
  );
  scope.get("/events/:eventId/report", member, async (request, reply) => {
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
  scope.post("/events/:eventId/report", member, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const team = organizerContextOf(request);
    const refund = admitStart(gate, team, reply);
    if (!(await recordReportPrint(deps, team, { eventId, requestId: request.id }))) {
      refund();
      throw notFound();
    }
    return reply.code(204).header("cache-control", "private, no-store").send();
  });
}
