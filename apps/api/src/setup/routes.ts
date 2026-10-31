import { setupSchema } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import { readSetup, saveSetup, type SetupDeps } from "#src/setup/setup";

const eventParams = z.object({ eventId: z.uuid() });
const member = { config: { access: "member" } } as const;
const writing = { config: { access: "member" }, bodyLimit: 1024 } as const;

/**
 * An event's guided setup progress (T-605, FR-1754, migration 0100): `GET …/events/:eventId/setup` answers the step it
 * will open at, what became of each of the ten steps and whether setup was finished; `PUT` saves that progress as given
 * (the last save wins). Owners and editors inside their event limit. The wizard's choices are not saved here: each step
 * calls the operation its dashboard page calls.
 */
export function registerSetupRoutes(scope: FastifyInstance, deps: SetupDeps): void {
  scope.get("/events/:eventId/setup", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const setup = await readSetup(deps, organizerContextOf(request), eventId);
    if (setup === undefined) {
      throw notFound();
    }
    return { setup };
  });

  scope.put("/events/:eventId/setup", writing, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const progress = parse(setupSchema, request.body);
    const setup = await saveSetup(deps, organizerContextOf(request), eventId, progress);
    if (setup === undefined) {
      throw notFound();
    }
    return { setup };
  });
}
