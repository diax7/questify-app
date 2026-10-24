import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { deviceUnpaired, unauthenticated } from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { checkOrigin } from "#src/auth/staff-guard";
import {
  claimDevice,
  eventDevices,
  operatorDevices,
  previewDevice,
  revokeDevice,
  revokeDevices,
  type Actor,
  type ClaimDeps,
} from "#src/devices/claims";
import { clientOf } from "#src/devices/client";
import {
  activateDevice,
  deviceScreenCode,
  deviceState,
  holdPoll,
  holdWrite,
  openPairing,
  operatorScreenCode,
  renewPairing,
  type DeviceDeps,
} from "#src/devices/devices";
import { deviceCookie, deviceOfCookie, type DeviceIdentity } from "#src/devices/guard";
import { organizerContextOf } from "#src/organizers/context";

const KINDS = ["station", "kiosk", "screen"] as const;
const kind = z.enum(KINDS);
const typedCode = z.string().min(1).max(32);
const label = z.string().max(200);
const pairingBody = z.strictObject({ kind });
const codeBody = z.strictObject({ code: typedCode });
const claimBody = z.strictObject({
  code: typedCode,
  kind,
  questId: z.uuid().nullable().default(null),
  label,
});
const revokeAllBody = z.union([
  z.strictObject({ kind: kind.nullable().optional() }),
  z.undefined(),
  z.null(),
]);
const emptyBody = z.union([z.strictObject({}), z.undefined(), z.null()]);
const eventParams = z.object({ eventId: z.uuid() });
const deviceParams = z.object({ eventId: z.uuid(), deviceId: z.uuid() });
const questParams = z.object({ eventId: z.uuid(), questId: z.uuid() });

const deviceRoute = { config: { access: "device" }, bodyLimit: 1024 } as const;
const anyDevice = { config: { access: "device", anyDevice: true }, bodyLimit: 1024 } as const;
const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
const playerIdempotent = {
  config: { access: "player", idempotent: true },
  bodyLimit: 1024,
} as const;
const member = { config: { access: "member" }, bodyLimit: 1024 } as const;
const writing = { config: { access: "member", idempotent: true }, bodyLimit: 1024 } as const;

const deviceOf = (request: FastifyRequest): DeviceIdentity => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the device guard answers first
  if (request.device === undefined) {
    throw deviceUnpaired();
  }
  return request.device;
};

const operatorOf = (request: FastifyRequest): Extract<Actor, { type: "operator" }> => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return { type: "operator", playerId: request.player.id };
};

const teamOf = (request: FastifyRequest): Extract<Actor, { type: "team" }> => {
  const context = organizerContextOf(request);
  return { type: "team", organizerId: context.organizerId, staffUserId: context.staffUserId };
};

/**
 * The device's own routes (T-309, ADR-239): the public pairing request (Origin checked; a call that carries a live
 * device cookie answers that device's state and makes nothing, so a reload never unpairs, CTO 4), and under the device
 * guard its state, a fresh code, the activation that replaces its secret (CTO 2) and a station's code.
 */
export function registerDeviceRoutes(app: FastifyInstance, deps: DeviceDeps): void {
  app.post(
    "/v1/device/pairing",
    { config: { access: "public" }, bodyLimit: 1024 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      checkOrigin(request, deps.dashboardOrigin, true);
      const body = parse(pairingBody, request.body);
      const held = await deviceOfCookie(deps.pool, request.headers.cookie);
      if (held !== undefined && !(held.state === "pending" && held.kind !== body.kind)) {
        return deviceState(deps, held);
      }
      const caller = callerOf(request);
      const made = await openPairing(
        deps,
        {
          kind: body.kind,
          client: clientOf(caller.userAgent ?? undefined),
          address: caller.address,
        },
        reply,
      );
      reply.header("set-cookie", deviceCookie(made.token));
      return reply.code(201).send(made.shown);
    },
  );

  app.get("/v1/device", anyDevice, async (request, reply) => {
    const device = deviceOf(request);
    await holdPoll(deps, device, reply);
    return deviceState(deps, device);
  });

  app.post("/v1/device/pairing/renew", anyDevice, async (request, reply) => {
    parse(emptyBody, request.body);
    const device = deviceOf(request);
    await holdWrite(deps, device, reply);
    return device.state === "pending" ? renewPairing(deps, device) : deviceState(deps, device);
  });

  app.post("/v1/device/activate", anyDevice, async (request, reply) => {
    parse(emptyBody, request.body);
    const device = deviceOf(request);
    await holdWrite(deps, device, reply);
    const token = await activateDevice(deps, device);
    if (token !== null) {
      reply.header("set-cookie", deviceCookie(token));
    }
    return { state: "paired", activated: true };
  });

  app.get("/v1/device/screen-code", deviceRoute, async (request, reply) => {
    const device = deviceOf(request);
    // Stryker disable next-line ConditionalExpression: unreachable: the guard lets only a paired, activated device here
    if (device.state !== "paired") {
      throw deviceUnpaired();
    }
    return deviceScreenCode(deps, device, reply);
  });
}

/**
 * Staff mode (T-309): an operator previews and claims a pairing code (a station with `show_rotating_qr`, within their
 * quest limit), lists and revokes what they paired, and shows a quest's rotating code on their own phone (FR-922).
 */
export function registerDeviceOperatorRoutes(
  app: FastifyInstance,
  deps: DeviceDeps & Readonly<{ claims: ClaimDeps }>,
): void {
  app.post("/v1/operator/events/:eventId/devices/preview", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const { code } = parse(codeBody, request.body);
    return previewDevice(deps.claims, { actor: operatorOf(request), eventId, code }, reply);
  });

  app.post("/v1/operator/events/:eventId/devices", playerIdempotent, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(claimBody, request.body);
    const id = await claimDevice(
      deps.claims,
      { actor: operatorOf(request), eventId, ...body, requestId: request.id },
      reply,
    );
    return reply.code(201).send({ id });
  });

  app.get("/v1/operator/events/:eventId/devices", player, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return operatorDevices(deps.claims, operatorOf(request).playerId, eventId);
  });

  app.post(
    "/v1/operator/events/:eventId/devices/:deviceId/revoke",
    player,
    async (request, reply) => {
      const { eventId, deviceId } = parse(deviceParams, request.params);
      parse(emptyBody, request.body);
      await revokeDevice(deps.claims, operatorOf(request), {
        eventId,
        deviceId,
        requestId: request.id,
      });
      return reply.code(204).send();
    },
  );

  app.get(
    "/v1/operator/events/:eventId/quests/:questId/screen-code",
    player,
    async (request, reply) => {
      const { eventId, questId } = parse(questParams, request.params);
      return operatorScreenCode(
        deps,
        { operatorId: operatorOf(request).playerId, eventId, questId },
        reply,
      );
    },
  );
}

/**
 * The event's Devices page in the organizer scope (owners and editors, T-309): the list, preview and claim of a code
 * (any kind), Revoke, and Revoke all or all big screens (ADR-241). Writes take an Idempotency-Key. They stay open while
 * the platform's `stations` switch is off, so devices can still be revoked.
 */
export function registerDeviceTeamRoutes(scope: FastifyInstance, deps: ClaimDeps): void {
  scope.get("/events/:eventId/devices", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return { devices: await eventDevices(deps, teamOf(request), eventId) };
  });

  scope.post("/events/:eventId/devices/preview", member, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const { code } = parse(codeBody, request.body);
    return previewDevice(deps, { actor: teamOf(request), eventId, code }, reply);
  });

  scope.post("/events/:eventId/devices", writing, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(claimBody, request.body);
    const id = await claimDevice(
      deps,
      { actor: teamOf(request), eventId, ...body, requestId: request.id },
      reply,
    );
    return reply.code(201).send({ id });
  });

  scope.post("/events/:eventId/devices/:deviceId/revoke", writing, async (request, reply) => {
    const { eventId, deviceId } = parse(deviceParams, request.params);
    parse(emptyBody, request.body);
    await revokeDevice(deps, teamOf(request), { eventId, deviceId, requestId: request.id });
    return reply.code(204).send();
  });

  scope.post("/events/:eventId/devices/revoke", writing, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(revokeAllBody, request.body);
    const revoked = await revokeDevices(deps, teamOf(request), {
      eventId,
      kind: body?.kind ?? null,
      requestId: request.id,
    });
    return { revoked };
  });
}
