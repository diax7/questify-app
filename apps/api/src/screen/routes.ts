import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { deviceUnpaired } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { DEVICE_LIMITS, holdBack } from "#src/devices/limits";
import { organizerContextOf } from "#src/organizers/context";
import { readBigScreen, saveBigScreen } from "#src/screen/big-screen";
import { SCENES, createSceneReader } from "#src/screen/scenes";
import type { Pool } from "pg";

const sceneParams = z.object({ scene: z.enum(SCENES) });
const eventParams = z.object({ eventId: z.uuid() });
/** The names are checked by the database (`invalid_big_screen`), so an unknown scene gets that answer, not a bare 422. */
const saveBody = z.strictObject({ scenes: z.array(z.string().max(20)).max(10) });

const deviceRoute = { config: { access: "device" }, bodyLimit: 1024 } as const;
const member = { config: { access: "member" } } as const;
const writing = { config: { access: "member", idempotent: true }, bodyLimit: 1024 } as const;

const seatOf = (request: FastifyRequest) => {
  const { organizerId, staffUserId } = organizerContextOf(request);
  return { organizerId, staffUserId };
};

export type ScreenDeps = Readonly<{ pool: Pool; keys: Pick<AuthKeys, "pairedDeviceKey"> }>;

/**
 * `GET /v1/device/screen/:scene` (T-504, FR-632 to FR-634): one scene's data for a paired, activated big screen's own
 * event. A station or kiosk, a pending, revoked or unactivated device is `device_unpaired`; 40 a minute per device (the
 * page asks every 3 seconds); never cached by a browser. Photo wall and Cheers are not scenes yet.
 */
export function registerScreenRoutes(app: FastifyInstance, deps: ScreenDeps): void {
  const scenes = createSceneReader({ pool: deps.pool });
  app.get("/v1/device/screen/:scene", deviceRoute, async (request, reply) => {
    const device = request.device;
    // Stryker disable next-line ConditionalExpression: unreachable: the guard lets only a paired, activated device here
    if (device === undefined || device.state !== "paired" || device.kind !== "screen") {
      throw deviceUnpaired();
    }
    const { scene } = parse(sceneParams, request.params);
    await holdBack(
      deps.pool,
      [{ limit: DEVICE_LIMITS.scenesPerDevice, key: deps.keys.pairedDeviceKey(device.id) }],
      true,
      reply,
    );
    return scenes.read({ id: device.id, eventId: device.eventId }, scene);
  });
}

/**
 * The event's Big screen page in the organizer scope (FR-631): the picked scenes and what is offered; the owner or
 * editor saves a new pick, in order (`PUT` replaces the list; it takes an Idempotency-Key like every team write).
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
}
