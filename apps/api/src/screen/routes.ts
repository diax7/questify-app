import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { deviceUnpaired } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { DEVICE_LIMITS, holdBack } from "#src/devices/limits";
import { organizerContextOf } from "#src/organizers/context";
import { readBigScreen, saveBigScreen } from "#src/screen/big-screen";
import { clearFinale, readFinale, saveFinale } from "#src/screen/finale";
import { SCREEN_SCENES, createSceneReader } from "#src/screen/scenes";
import type { Pool } from "pg";

const sceneParams = z.object({ scene: z.enum(SCREEN_SCENES) });
const eventParams = z.object({ eventId: z.uuid() });
/** The names are checked by the database (`invalid_big_screen`), so an unknown scene gets that answer, not a bare 422. */
const saveBody = z.strictObject({ scenes: z.array(z.string().max(20)).max(10) });
const finaleBody = z.strictObject({
  startsAt: z.iso.datetime({ offset: true }),
  goalId: z.uuid().nullable(),
});

const deviceRoute = { config: { access: "device" }, bodyLimit: 1024 } as const;
const member = { config: { access: "member" } } as const;
const writing = { config: { access: "member", idempotent: true }, bodyLimit: 1024 } as const;
const ownerWriting = { config: { access: "owner", idempotent: true }, bodyLimit: 1024 } as const;

const seatOf = (request: FastifyRequest) => {
  const { organizerId, staffUserId } = organizerContextOf(request);
  return { organizerId, staffUserId };
};

export type ScreenDeps = Readonly<{ pool: Pool; keys: Pick<AuthKeys, "pairedDeviceKey"> }>;

/**
 * `GET /v1/device/screen/:scene` (T-504, FR-632 to FR-634): one scene's data for a paired, activated big screen's own
 * event. A station or kiosk, a pending, revoked or unactivated device is `device_unpaired`; 40 a minute per device (the
 * page asks every 3 seconds); never cached by a browser. Photo wall and Cheers are not scenes yet. The finale's answer
 * also carries `serverNow`, so the countdown follows the server's clock and not the TV's (T-307b).
 */
export function registerScreenRoutes(app: FastifyInstance, deps: ScreenDeps): void {
  const scenes = createSceneReader({ pool: deps.pool });
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
    return scene === "finale" ? { ...answer, serverNow: new Date().toISOString() } : answer;
  });
}

/**
 * The event's Big screen page in the organizer scope (FR-631): the picked scenes and what is offered; the owner or
 * editor saves a new pick, in order (`PUT` replaces the list; it takes an Idempotency-Key like every team write).
 * The finale (T-307b, FR-254): any member reads it; the owner sets its time and goal (`PUT`) and clears it (`DELETE`).
 */
export function registerScreenTeamRoutes(
  scope: FastifyInstance,
  deps: Pick<ScreenDeps, "pool">,
): void {
  scope.get("/events/:eventId/big-screen", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return readBigScreen(deps.pool, seatOf(request), eventId);
  });

  scope.put("/events/:eventId/big-screen", writing, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { scenes } = parse(saveBody, request.body);
    return saveBigScreen(deps.pool, seatOf(request), {
      eventId,
      scenes,
      requestId: request.id,
    });
  });

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
