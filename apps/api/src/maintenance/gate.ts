import type { PlatformSettings } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { HttpError } from "#src/http-error";
import type { SettingsService } from "#src/settings/service";

/** What a play door names to say which event it acts on. */
type EventRef =
  | Readonly<{ kind: "event"; id: string }>
  | Readonly<{ kind: ParamKind | "join_code"; ref: string }>;

/** The kinds `play_event_id` (migrations 0134, 0190) finds an event by, from an id the door carries. */
export type ParamKind =
  | "quest"
  | "step"
  | "category"
  | "reward"
  | "session"
  | "desk_sale"
  | "game_round"
  | "meet_pass"
  | "redemption";

/** How a door finds its event: a reference, null for a door that holds on a platform-wide pause only, or nothing. */
type Door = (request: FastifyRequest) => EventRef | null | undefined;

const paramOf = (request: FastifyRequest, name: string): string | undefined => {
  const value = (request.params as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
};

function param(request: FastifyRequest, name: string, kind: ParamKind): EventRef | undefined {
  const ref = paramOf(request, name);
  return ref === undefined ? undefined : { kind, ref };
}

const bodyField = (request: FastifyRequest, name: string): string | undefined => {
  const value = (request.body as Record<string, unknown> | null | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
};

const ofQuest: Door = (request) => param(request, "questId", "quest");
const ofEventParam: Door = (request) => {
  const id = paramOf(request, "eventId");
  return id === undefined ? undefined : { kind: "event", id };
};
/** A door whose event only a signed code, a pass or a player's own record names: held by the platform-wide pause alone. */
const platformWide: Door = () => null;

/**
 * The play doors, by `METHOD route`: every player or device write that spends or earns (points, XP, a reserved
 * prize, a stamp), each with the way to find the event it acts on. `test/security/maintenance-doors.int.test.ts` walks
 * every player and device write route and fails unless it is here or on that test's open list, so an earning door
 * cannot ship unpaused.
 */
export const PLAY_DOORS: Readonly<Record<string, Door>> = {
  "POST /v1/quests/:questId/complete": ofQuest,
  "POST /v1/quests/:questId/vote": ofQuest,
  "POST /v1/quests/:questId/survey": ofQuest,
  "POST /v1/quests/:questId/share": ofQuest,
  "POST /v1/quests/:questId/quiz/start": ofQuest,
  "POST /v1/quests/:questId/quiz/next": ofQuest,
  "POST /v1/quests/:questId/quiz/answer": ofQuest,
  "POST /v1/quests/:questId/submit": ofQuest,
  "POST /v1/quests/:questId/game-rounds": ofQuest,
  "POST /v1/game-rounds/:roundId/result": (request) => param(request, "roundId", "game_round"),
  "POST /v1/steps/:stepId/stamp": (request) => param(request, "stepId", "step"),
  "POST /v1/categories/:categoryId/reveal": (request) => param(request, "categoryId", "category"),
  "POST /v1/rewards/:rewardId/reserve": (request) => param(request, "rewardId", "reward"),
  "POST /v1/desk-sales/:saleId/accept": (request) => param(request, "saleId", "desk_sale"),
  "PUT /v1/events/:eventId/goal": ofEventParam,
  "POST /v1/events/:eventId/operator/play": ofEventParam,
  "POST /v1/join": (request) => {
    const eventId = bodyField(request, "eventId");
    if (eventId !== undefined) {
      return { kind: "event", id: eventId };
    }
    const joinCode = bodyField(request, "joinCode");
    return joinCode === undefined ? undefined : { kind: "join_code", ref: joinCode };
  },
  // The operator's own doors that pay a player (ADR-471): the station's scan and manual award, the session check-in and
  // an approved submission. The organizer's dashboard (awards, review, everything under /v1/organizers) is never held.
  "POST /v1/operator/scan": (request) => {
    const questId = bodyField(request, "questId");
    return questId === undefined ? undefined : { kind: "quest", ref: questId };
  },
  "POST /v1/operator/award": (request) => {
    const id = bodyField(request, "eventId");
    return id === undefined ? undefined : { kind: "event", id };
  },
  "POST /v1/operator/sessions/:sessionId/check-in": (request) =>
    param(request, "sessionId", "session"),
  "POST /v1/operator/events/:eventId/submissions/:submissionId/review": ofEventParam,
  // A kiosk is paired to one event, so its scan is held by that event's pause too.
  "POST /v1/device/kiosk-scans": (request) =>
    request.device?.state === "paired" ? { kind: "event", id: request.device.eventId } : undefined,
  "POST /v1/taps": platformWide,
  "POST /v1/meet": platformWide,
  "POST /v1/me/questify/sync": platformWide,
  "POST /v1/me/daily/challenge/answers": platformWide,
  "POST /v1/me/daily/word/guesses": platformWide,
};

/** The 503 a paused door answers: the admin's own message in both languages, and whether the pause is platform-wide. */
const paused = (message: { ar: string; en: string }, scope: "platform" | "event"): HttpError =>
  new HttpError(503, "maintenance", message, { scope });

/** The lookups one request already made, by kind and id: the player guard and this gate ask once between them. */
const lookups = new WeakMap<FastifyRequest, Map<string, Promise<string | undefined>>>();

async function lookUp(pool: Pool, kind: string, ref: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string | null }>("SELECT play_event_id($1, $2) AS id", [
    kind,
    ref,
  ]);
  return rows[0]?.id ?? undefined;
}

/**
 * The event a reference names (lowercase), or undefined for an id that names nothing. A lookup (`play_event_id`) is
 * made once per request: the player guard's suspension wall and the maintenance gate share it.
 */
export function eventOfRef(
  pool: Pool,
  ref: EventRef,
  request: FastifyRequest,
): Promise<string | undefined> {
  if (ref.kind === "event") {
    return Promise.resolve(ref.id.toLowerCase());
  }
  let made = lookups.get(request);
  if (made === undefined) {
    made = new Map();
    lookups.set(request, made);
  }
  const key = `${ref.kind} ${ref.ref}`;
  let found = made.get(key);
  if (found === undefined) {
    found = lookUp(pool, ref.kind, ref.ref);
    made.set(key, found);
  }
  return found;
}

/** The pause, if any, that holds this door: the platform's, else the event's own. */
async function holdingMessage(
  pool: Pool,
  maintenance: NonNullable<PlatformSettings["maintenance"]>,
  request: FastifyRequest,
  ref: EventRef | null | undefined,
): Promise<HttpError | undefined> {
  if (maintenance.global !== undefined) {
    return paused(maintenance.global, "platform");
  }
  if (ref === null || ref === undefined || Object.keys(maintenance.events).length === 0) {
    return undefined;
  }
  const eventId = await eventOfRef(pool, ref, request);
  const message = eventId === undefined ? undefined : maintenance.events[eventId];
  return message === undefined ? undefined : paused(message, "event");
}

/** What a held door tells a retrying client: the app's queue tries again, and the pause may last minutes or hours. */
const RETRY_AFTER_SECONDS = "60";

/**
 * Maintenance mode (T-703b, FR-1771): while the platform or the door's event has a message, the play doors (`PLAY_DOORS`:
 * everything a player, a kiosk or a station operator does that earns or spends) answer 503 `maintenance` with that
 * message and a `Retry-After`. The answer is retryable, so the app's queue keeps the scan until play resumes, and a 5xx
 * frees the idempotency key. Reads, leaving, the dashboard, the console and the configuration door are never held, so a
 * platform admin and the team are never locked out and the app always gets its configuration. The reading is the
 * settings service's (cached, cleared on every save); it runs after the player and device guards, so only a signed-in
 * caller's request reaches it.
 */
export function registerMaintenanceGate(
  app: FastifyInstance,
  deps: Readonly<{ pool: Pool; settings: Pick<SettingsService, "platform"> }>,
): void {
  app.addHook("preHandler", async (request, reply) => {
    const door = PLAY_DOORS[`${request.method} ${request.routeOptions.url ?? ""}`];
    if (door === undefined) {
      return;
    }
    const { maintenance } = await deps.settings.platform();
    if (maintenance === undefined) {
      return;
    }
    const held = await holdingMessage(deps.pool, maintenance, request, door(request));
    if (held !== undefined) {
      reply.header("retry-after", RETRY_AFTER_SECONDS);
      throw held;
    }
  });
}
