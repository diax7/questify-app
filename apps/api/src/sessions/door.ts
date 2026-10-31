import type { SessionCheckInAnswer } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { unauthenticated } from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { sessionCall, sessionRefusal, type SessionDeps } from "#src/sessions/store";
import { verifyMyCode, type MyCodeKey } from "#src/quests/qr";

const params = z.object({ sessionId: z.uuid() });
const eventParams = z.object({ eventId: z.uuid() });
const body = z.strictObject({ code: z.string().min(1).max(200) });

/** Why the door shows red, with the station scan's words (FR-924); the database's codes are the keys. */
const RED: Readonly<Record<string, string>> = {
  OA403: "ability_off",
  OS403: "outside_station",
  OY409: "self_scan",
  OM422: "old_code",
  QC404: "not_in_event",
  QC403: "enrollment_inactive",
  // T-505b: the door pays points, so it answers only while the player may play and the agenda is on.
  QN403: "event_not_live",
  AG403: "feature_off",
};

export type DoorDeps = SessionDeps & Readonly<{ myKey: MyCodeKey }>;

type Opened = Readonly<{ playerId: string; version: number }>;

/** The route's body for the database's answer: the outcome, the walk-in flag, the points the player holds, who. */
const doorBody = (answer: SessionCheckInAnswer) => ({
  result: answer.outcome,
  walkIn: answer.walkIn === true,
  points: answer.points ?? 0,
  player: answer.player,
});

/** The database's answer for one scan, or a red result with the station scan's reason; anything else is rethrown. */
async function recordCheckIn(
  deps: DoorDeps,
  operatorId: string,
  sessionId: string,
  opened: Opened,
) {
  try {
    const answer = await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: operatorId }, async () => {
        const { rows } = await client.query<{ answer: SessionCheckInAnswer }>(
          "SELECT session_check_in($1, $2, $3) AS answer",
          [sessionId, opened.playerId, opened.version],
        );
        return (rows[0] as { answer: SessionCheckInAnswer }).answer;
      }),
    );
    return doorBody(answer);
  } catch (error) {
    const reason = RED[(error as { code?: string }).code ?? ""];
    if (reason === undefined) return sessionRefusal(error);
    return { result: "refused", reason, player: null };
  }
}

/**
 * The door check-in (FR-1791, T-505): an operator scans a player's My QR at a session. The API opens the code; the
 * database checks the operator, their ability and the player's code version, and records the attendance once. The
 * answer is a result the station shows in a colour: `checked_in`, `already`, `not_registered`, `too_early`, `ended`, or
 * `refused` with a reason. `checked_in` and `already` carry the session's points the player holds (T-505b, FR-1791): paid
 * once per player and session (the pair is the key; no client key is needed). A removed operator gets 403 and leaves
 * operator mode, as on the quest scan.
 */
export function registerSessionDoorRoutes(app: FastifyInstance, deps: DoorDeps): void {
  app.post(
    "/v1/operator/sessions/:sessionId/check-in",
    { config: { access: "player" }, bodyLimit: 1024 },
    async (request, reply) => {
      const { sessionId } = parse(params, request.params);
      const { code } = parse(body, request.body);
      const operatorId = request.player?.id;
      if (operatorId === undefined) throw unauthenticated();
      reply.header("cache-control", "private, no-store");
      const opened = verifyMyCode(deps.myKey, code);
      if (opened.kind === "valid") return recordCheckIn(deps, operatorId, sessionId, opened);
      callerOf(request).log("operator.session_check_in_refused", { problem: opened.kind });
      return { result: "refused", reason: "invalid_code", player: null };
    },
  );
  app.get(
    "/v1/operator/events/:eventId/sessions",
    { config: { access: "player" } },
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      const operatorId = request.player?.id;
      if (operatorId === undefined) throw unauthenticated();
      reply.header("cache-control", "private, no-store");
      const result = await sessionCall<{ sessions: unknown[] }>(
        deps,
        { playerId: operatorId },
        "SELECT operator_sessions($1) AS sessions",
        [eventId],
      );
      return { sessions: result.sessions };
    },
  );
}
