import type { PlatformSettings } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { HttpError } from "#src/http-error";
import type { SettingsService } from "#src/settings/service";

/** What a play door names to say which event it acts on. */
type EventRef =
  | Readonly<{ kind: "event"; id: string }>
  | Readonly<{ kind: "quest" | "step" | "category" | "reward" | "join_code"; ref: string }>;

const paramOf = (request: FastifyRequest, name: string): string | undefined => {
  const value = (request.params as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
};

function param(
  request: FastifyRequest,
  name: string,
  kind: "quest" | "step" | "category" | "reward",
): EventRef | undefined {
  const ref = paramOf(request, name);
  return ref === undefined ? undefined : { kind, ref };
}

/** The play doors, by `METHOD route`, each with the way to find the event it acts on; null for a door of no event. */
const PLAY_DOORS: Readonly<
  Record<string, (request: FastifyRequest) => EventRef | null | undefined>
> = {
  "POST /v1/quests/:questId/complete": (request) => param(request, "questId", "quest"),
  "POST /v1/steps/:stepId/stamp": (request) => param(request, "stepId", "step"),
  "POST /v1/categories/:categoryId/reveal": (request) => param(request, "categoryId", "category"),
  "POST /v1/rewards/:rewardId/reserve": (request) => param(request, "rewardId", "reward"),
  "PUT /v1/events/:eventId/goal": (request) => {
    const id = paramOf(request, "eventId");
    return id === undefined ? undefined : { kind: "event", id };
  },
  "POST /v1/join": (request) => {
    const body = request.body as { joinCode?: unknown; eventId?: unknown } | null | undefined;
    if (typeof body?.eventId === "string") {
      return { kind: "event", id: body.eventId };
    }
    return typeof body?.joinCode === "string"
      ? { kind: "join_code", ref: body.joinCode }
      : undefined;
  },
  "POST /v1/me/questify/sync": () => null,
};

/** The 503 a paused door answers: the admin's own message in both languages, and whether the pause is platform-wide. */
const paused = (message: { ar: string; en: string }, scope: "platform" | "event"): HttpError =>
  new HttpError(503, "maintenance", message, { scope });

async function eventOf(pool: Pool, ref: EventRef): Promise<string | undefined> {
  if (ref.kind === "event") {
    return ref.id.toLowerCase();
  }
  const { rows } = await pool.query<{ id: string | null }>("SELECT play_event_id($1, $2) AS id", [
    ref.kind,
    ref.ref,
  ]);
  return rows[0]?.id ?? undefined;
}

/** The pause, if any, that holds this door: the platform's, else the event's own. */
async function holdingMessage(
  pool: Pool,
  maintenance: NonNullable<PlatformSettings["maintenance"]>,
  ref: EventRef | null | undefined,
): Promise<HttpError | undefined> {
  if (maintenance.global !== undefined) {
    return paused(maintenance.global, "platform");
  }
  if (ref === null || ref === undefined || Object.keys(maintenance.events).length === 0) {
    return undefined;
  }
  const eventId = await eventOf(pool, ref);
  const message = eventId === undefined ? undefined : maintenance.events[eventId];
  return message === undefined ? undefined : paused(message, "event");
}

/**
 * Maintenance mode (T-703b, FR-1771): while the platform or the door's event has a message, the play doors (a scan, a
 * stamp, a reveal, a reservation, the goal, joining and Questify's sync) answer 503 `maintenance` with that message. The
 * answer is retryable, so the app's queue keeps the scan until play resumes, and a 5xx frees the idempotency key. Reads,
 * leaving, the dashboard, the operator doors, the console and the configuration door are never held, so a platform admin
 * and the team are never locked out and the app always gets its configuration. The reading is the settings service's
 * (cached, cleared on every save); it runs after the player guard, so only a signed-in player's call reaches it.
 */
export function registerMaintenanceGate(
  app: FastifyInstance,
  deps: Readonly<{ pool: Pool; settings: Pick<SettingsService, "platform"> }>,
): void {
  app.addHook("preHandler", async (request) => {
    const door = PLAY_DOORS[`${request.method} ${request.routeOptions.url ?? ""}`];
    if (door === undefined) {
      return;
    }
    const { maintenance } = await deps.settings.platform();
    if (maintenance === undefined) {
      return;
    }
    const held = await holdingMessage(deps.pool, maintenance, door(request));
    if (held !== undefined) {
      throw held;
    }
  });
}
