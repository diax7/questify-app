import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { deviceUnpaired } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { DEVICE_LIMITS, holdBack } from "#src/devices/limits";
import { organizerContextOf } from "#src/organizers/context";
import { readBigScreen, saveBigScreen, type BigScreenPlan } from "#src/screen/big-screen";
import { clearFinale, readFinale, saveFinale } from "#src/screen/finale";
import {
  memberWall,
  readTeamWall,
  saveTeamWall,
  setOnScreen,
  type PhotoWallDeps,
} from "#src/screen/photo-wall";
import { SCREEN_SCENES, createSceneReader } from "#src/screen/scenes";
import type { Pool } from "pg";
import { unauthenticated } from "#src/auth/http-errors";
import { teamSeat, type OrganizerContext } from "#src/organizers/store";
import type { ObjectStore } from "#src/storage/client";

const sceneParams = z.object({ scene: z.enum(SCREEN_SCENES) });
const eventParams = z.object({ eventId: z.uuid() });
/** The names are checked by the database (`invalid_big_screen`), so an unknown scene gets that answer, not a bare 422. */
const saveBody = z.strictObject({ scenes: z.array(z.string().max(20)).max(10) });
const finaleBody = z.strictObject({
  startsAt: z.iso.datetime({ offset: true }),
  goalId: z.uuid().nullable(),
});

const wallBody = z.strictObject({
  submissionIds: z.array(z.string().regex(/^[1-9]\d{0,17}$/)).max(20),
});
const wallQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,17}$/)
    .optional(),
});
const consentParams = z.object({
  eventId: z.uuid(),
  submissionId: z.string().regex(/^[1-9]\d{0,17}$/),
});
const consentBody = z.strictObject({ onScreen: z.boolean() });

const deviceRoute = { config: { access: "device" }, bodyLimit: 1024 } as const;
const member = { config: { access: "member" } } as const;
const writing = { config: { access: "member", idempotent: true }, bodyLimit: 1024 } as const;
const ownerWriting = { config: { access: "owner", idempotent: true }, bodyLimit: 1024 } as const;

/** The caller's organizer context, a support view's read-only mark included (T-712). */
const seatOf = (request: FastifyRequest): OrganizerContext => organizerContextOf(request);

export type ScreenDeps = Readonly<{
  pool: Pool;
  keys: Pick<AuthKeys, "pairedDeviceKey">;
  /** The photo bucket (T-504b); without one the photo scene answers an empty list. */
  storage?: ObjectStore | undefined;
}>;

/** Without a bucket the photo scene is not offered: it could only ever show an empty wall. */
const offeredHere = (plan: BigScreenPlan, storage: ObjectStore | undefined): BigScreenPlan =>
  storage === undefined
    ? { ...plan, offered: plan.offered.filter((scene) => scene !== "photo") }
    : plan;

/**
 * `GET /v1/device/screen/:scene` (T-504, FR-632 to FR-634): one scene's data for a paired, activated big screen's own
 * event. A station or kiosk, a pending, revoked or unactivated device is `device_unpaired`; 40 a minute per device (the
 * page asks every 3 seconds); never cached by a browser. The photo scene (T-504b) answers signed URLs, never keys. The finale's and the Cheers
 * answers also carry `serverNow`, so the countdown follows the server's clock and not the TV's (T-307b, T-509).
 */
export function registerScreenRoutes(app: FastifyInstance, deps: ScreenDeps): void {
  const scenes = createSceneReader({ pool: deps.pool, storage: deps.storage });
  app.get("/v1/device/screen/:scene", deviceRoute, async (request, reply) => {
    const device = request.device;
    if (device === undefined || device.state !== "paired" || device.kind !== "screen") {
      throw deviceUnpaired();
    }
    const { scene } = parse(sceneParams, request.params);
    await holdBack(
      deps.pool,
      [
        {
          limit: DEVICE_LIMITS.scenesPerDevice,
          key: deps.keys.pairedDeviceKey(`${device.id}:scene`),
        },
      ],
      true,
      reply,
    );
    const answer = await scenes.read({ id: device.id, eventId: device.eventId }, scene);
    return scene === "finale" || scene === "cheers"
      ? { ...answer, serverNow: new Date().toISOString() }
      : answer;
  });
}

/**
 * The event's Big screen page in the organizer scope (FR-631): the picked scenes and what is offered; the owner or
 * editor saves a new pick, in order (`PUT` replaces the list; it takes an Idempotency-Key like every team write).
 * The finale (T-307b, FR-254): any member reads it; the owner sets its time and goal (`PUT`) and clears it (`DELETE`).
 */
export function registerScreenTeamRoutes(
  scope: FastifyInstance,
  deps: Pick<ScreenDeps, "pool" | "storage">,
): void {
  scope.get("/events/:eventId/big-screen", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return offeredHere(await readBigScreen(deps.pool, seatOf(request), eventId), deps.storage);
  });

  scope.put("/events/:eventId/big-screen", writing, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { scenes } = parse(saveBody, request.body);
    const plan = await saveBigScreen(deps.pool, seatOf(request), {
      eventId,
      scenes,
      requestId: request.id,
    });
    return offeredHere(plan, deps.storage);
  });
  registerPhotoWallTeamRoutes(scope, deps);

  scope.get("/events/:eventId/finale", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return readFinale(deps.pool, seatOf(request), eventId);
  });

  scope.put("/events/:eventId/finale", ownerWriting, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { startsAt, goalId } = parse(finaleBody, request.body);
    return saveFinale(deps.pool, seatOf(request), {
      eventId,
      startsAt: new Date(startsAt),
      goalId,
      requestId: request.id,
    });
  });

  scope.delete("/events/:eventId/finale", ownerWriting, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return clearFinale(deps.pool, seatOf(request), { eventId, requestId: request.id });
  });
}

/**
 * The photo wall's picker (T-504b, FR-636): any member reads the current pick and a page of eligible photos (each with a
 * 120-second URL, never a key, never a player's name); the owner or editor saves the pick in order (`PUT` replaces it,
 * at most 20, with an Idempotency-Key).
 */
function registerPhotoWallTeamRoutes(scope: FastifyInstance, deps: PhotoWallDeps): void {
  scope.get("/events/:eventId/photo-wall", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    const { cursor } = parse(wallQuery, request.query);
    return readTeamWall(deps, teamSeat(seatOf(request)), eventId, cursor ?? null);
  });
  scope.put("/events/:eventId/photo-wall", writing, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { submissionIds } = parse(wallBody, request.body);
    const picked = await saveTeamWall(deps, teamSeat(seatOf(request)), {
      eventId,
      submissionIds,
      requestId: request.id,
    });
    return { picked };
  });
}

const playerOf = (request: FastifyRequest): string => {
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

/**
 * The player's side of the photo wall (T-504b): the event's wall while it runs (`GET`, an active member, each photo
 * with a 120-second URL and its owner's username for Block, never cached), and the per-photo choice for one of the
 * player's own photo submissions (`PUT .../on-screen`; off takes it off the wall at once, M6).
 */
export function registerPhotoWallPlayerRoutes(app: FastifyInstance, deps: PhotoWallDeps): void {
  app.get(
    "/v1/events/:eventId/photo-wall",
    { config: { access: "player" } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const { eventId } = parse(eventParams, request.params);
      return { photos: await memberWall(deps, playerOf(request), eventId) };
    },
  );
  app.put(
    "/v1/events/:eventId/submissions/:submissionId/on-screen",
    { config: { access: "player", idempotent: true }, bodyLimit: 1024 },
    async (request) => {
      const { eventId, submissionId } = parse(consentParams, request.params);
      const { onScreen } = parse(consentBody, request.body);
      return {
        onScreen: await setOnScreen(deps, playerOf(request), { eventId, submissionId, onScreen }),
      };
    },
  );
}
