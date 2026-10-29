import { organizerAlertSwitchesSchema } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { invalidRequest, notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  readOwnAlertSwitches,
  saveOwnAlertSwitches,
  type AlertDeps,
  type AlertSwitchesResult,
} from "#src/organizer-alerts/alerts";
import { organizerContextOf } from "#src/organizers/context";

const BODY_LIMIT = 1024;
const read = { config: { access: "member" } } as const;
const write = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;

/** One HTTP answer per refusal (API.md, organizer alerts). */
function answer(result: AlertSwitchesResult) {
  switch (result.kind) {
    case "done":
      return result.switches;
    case "not_found":
      throw notFound();
    case "invalid":
      throw invalidRequest();
  }
}

/**
 * The calling team member's own email-alert switches in the organizer scope (T-503, FR-1727): `GET` reads them and `PUT`
 * saves all seven. Both are for the signed-in member only: the route takes no member id, so an owner cannot read or
 * change another member's switches, and the database acts only on the calling member (migration 0082).
 */
export function registerOrganizerAlertRoutes(scope: FastifyInstance, deps: AlertDeps): void {
  scope.get("/alerts/me", read, async (request) =>
    answer(await readOwnAlertSwitches(deps, organizerContextOf(request))),
  );

  scope.put("/alerts/me", write, async (request) => {
    const switches = parse(organizerAlertSwitchesSchema, request.body);
    const saved = answer(
      await saveOwnAlertSwitches(deps, organizerContextOf(request), {
        switches,
        requestId: request.id,
      }),
    );
    request.log.info({ event: "organizer.alerts_set" });
    return saved;
  });
}
