import { streakSettingsBodySchema, type StreakField } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidRequest, invalidStreak, notFound, streakConflict } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import {
  readStreakSettings,
  saveStreakSettings,
  type StreakDeps,
  type StreakDone,
  type StreakRefusal,
} from "#src/streaks/streaks";

const member = { config: { access: "member" } } as const;
// 366 closed dates fit in about 5 KB.
const owner = { config: { access: "owner", idempotent: true }, bodyLimit: 16 * 1024 } as const;

const eventParams = z.object({ eventId: z.uuid() });

/** One HTTP answer per refusal (API.md, streaks). */
function refuse(result: StreakRefusal): never {
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "conflict":
      throw streakConflict(
        result.day === null
          ? { reason: result.reason }
          : { reason: result.reason, day: result.day },
      );
    case "invalid":
      throw invalidStreak({ field: result.field });
  }
}

const valueOf = <T>(result: StreakDone<T>): T =>
  result.kind === "done" ? result.value : refuse(result);

const FIELDS: ReadonlySet<string> = new Set<StreakField>([
  "enabled",
  "bonusPoints",
  "closedWeekdays",
  "closedDays",
]);

/**
 * The body checked here first, naming the first listed field at fault (`invalid_streak {field}`); a body that is not
 * an object, or has an unknown key and no bad field, is a plain 400 `invalid_request`.
 */
const bodyOf = (body: unknown) => {
  const result = streakSettingsBodySchema.safeParse(body);
  if (!result.success) {
    const named = result.error.issues
      .map((issue) => String(issue.path[0] ?? ""))
      .find((field) => FIELDS.has(field));
    if (named === undefined) {
      throw invalidRequest();
    }
    throw invalidStreak({ field: named });
  }
  return result.data;
};

/**
 * The event day streak's settings in the organizer scope (T-405, FR-417, FR-418, FR-1615): owners and editors read them
 * (`GET`), owners set them (`PUT` with an Idempotency-Key, audited by the database).
 */
export function registerStreakTeamRoutes(scope: FastifyInstance, deps: StreakDeps): void {
  scope.get("/events/:eventId/streak", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return {
      streak: valueOf(await readStreakSettings(deps, organizerContextOf(request), eventId)),
    };
  });

  scope.put("/events/:eventId/streak", owner, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = bodyOf(request.body);
    const saved = valueOf(
      await saveStreakSettings(deps, organizerContextOf(request), {
        eventId,
        body,
        requestId: request.id,
      }),
    );
    request.log.info({ event: "event.streak_set", replayed: saved.replayed });
    return { streak: saved.settings };
  });
}
