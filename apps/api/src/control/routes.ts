import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eventClosed, notFound, notInOrder } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import type { ControlReader } from "#src/control/control";
import {
  setRoomSwitch,
  type PauseDeps,
  type RoomSwitch,
  type SwitchDone,
} from "#src/control/pause";
import { organizerContextOf } from "#src/organizers/context";

const eventParams = z.object({ eventId: z.uuid() });
const switchParams = z.object({ eventId: z.uuid(), questId: z.uuid() });
const SWITCHES: readonly RoomSwitch[] = ["pause", "resume", "skip", "unskip"];
const emptyBody = z.union([z.strictObject({}), z.undefined(), z.null()]);

/** The switch's answer, or its refusal thrown (API.md, the control room). */
function switchValueOf(result: SwitchDone) {
  switch (result.kind) {
    case "done":
      return result.value;
    case "not_found":
      throw notFound();
    case "event_closed":
      throw eventClosed();
    case "not_in_order":
      throw notInOrder();
  }
}

/**
 * `GET …/events/:eventId/control` for the team (T-603, FR-1024, FR-1028): the live control room's one poll. The newest
 * completions (username and avatar the team already reads, never a contact detail or points), the counters, and the
 * players who completed each quest. `POST …/quests/:questId/pause|resume|skip|unskip` (T-603b, FR-1026): pause a quest
 * or skip a step of an in-order category, and undo either. Owners and editors within their event limit; another
 * organizer's event or quest is 404.
 */
export function registerControlTeamRoutes(
  scope: FastifyInstance,
  reader: ControlReader,
  deps: PauseDeps,
): void {
  scope.get(
    "/events/:eventId/control",
    { config: { access: "member" }, bodyLimit: 1024 },
    async (request) => {
      const { eventId } = parse(eventParams, request.params);
      const view = await reader.read(organizerContextOf(request), eventId);
      if (view === undefined) {
        throw notFound();
      }
      return view;
    },
  );

  for (const action of SWITCHES) {
    scope.post(
      `/events/:eventId/quests/:questId/${action}`,
      { config: { access: "member", idempotent: true }, bodyLimit: 1024 },
      async (request) => {
        const { eventId, questId } = parse(switchParams, request.params);
        parse(emptyBody, request.body);
        const target = { eventId, questId, action, requestId: request.id };
        return switchValueOf(await setRoomSwitch(deps, organizerContextOf(request), target));
      },
    );
  }
}
