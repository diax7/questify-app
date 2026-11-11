import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { holdBack } from "#src/devices/limits";
import { HttpError } from "#src/http-error";
import {
  createInvites,
  listOperators,
  removeOperator,
  revokeInvite,
  updateOperator,
} from "#src/operators/operators";
import {
  STATION_TODAY_LIMIT,
  registerOperatorPlayerRoutes,
  registerOperatorRoutes,
  type OperatorPlayerDeps,
} from "#src/operators/routes";
import { stationToday } from "#src/operators/station-today";

vi.mock("#src/devices/limits", () => ({ holdBack: vi.fn() }));
vi.mock("#src/operators/station-today", () => ({ stationToday: vi.fn() }));
vi.mock("#src/operators/operators", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/operators/operators")>()),
  createInvites: vi.fn(),
  listOperators: vi.fn(),
  removeOperator: vi.fn(),
  revokeInvite: vi.fn(),
  updateOperator: vi.fn(),
}));

type Registered = Readonly<{ method: string; url: string; config: unknown; bodyLimit: unknown }>;

/** Every route a register function adds, in registration order, with its guard config and body limit. */
async function registered(register: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify({ exposeHeadRoutes: false });
  const routes: Registered[] = [];
  app.addHook("onRoute", (route) => {
    routes.push({
      method: [route.method].flat().join(","),
      url: route.url,
      config: route.config,
      bodyLimit: route.bodyLimit,
    });
  });
  register(app);
  await app.ready();
  await app.close();
  return routes;
}

const member = { access: "member" };
const owner = { access: "owner" };

describe("the operator routes", () => {
  it("registers the owner's routes, in this order, with these guards", async () => {
    const routes = await registered((app) => registerOperatorRoutes(app, {} as never));
    expect(routes).toEqual([
      { method: "GET", url: "/events/:eventId/operators", config: member, bodyLimit: 4096 },
      {
        method: "POST",
        url: "/events/:eventId/operators/invites",
        config: { access: "owner", idempotent: true },
        bodyLimit: 4096,
      },
      {
        method: "DELETE",
        url: "/events/:eventId/operators/invites/:inviteId",
        config: owner,
        bodyLimit: 4096,
      },
      {
        method: "PUT",
        url: "/events/:eventId/operators/:operatorId",
        config: owner,
        bodyLimit: 4096,
      },
      {
        method: "DELETE",
        url: "/events/:eventId/operators/:operatorId",
        config: owner,
        bodyLimit: 4096,
      },
    ]);
  });

  it("registers the person's routes, in this order, with these guards", async () => {
    const routes = await registered((app) =>
      registerOperatorPlayerRoutes(app, { pool: {}, myKey: {} } as unknown as OperatorPlayerDeps),
    );
    const plain = '{"access":"player"}';
    const idempotent = '{"access":"player","idempotent":true}';
    expect(
      routes.map((r) => `${r.method} ${r.url} ${JSON.stringify(r.config)} ${r.bodyLimit}`),
    ).toEqual([
      `POST /v1/operator-invites/preview ${plain} 1024`,
      `POST /v1/operator-invites/claim ${idempotent} 1024`,
      `GET /v1/me/operator-events ${plain} 1024`,
      `GET /v1/operator/events/:eventId/stations ${plain} 1024`,
      `POST /v1/events/:eventId/operator/play ${idempotent} 1024`,
      `GET /v1/me/qr ${plain} 1024`,
      `POST /v1/me/qr/reset ${idempotent} 1024`,
      `GET /v1/operator/events/:eventId/stations/:questId/today ${plain} 1024`,
      `POST /v1/operator/sessions/:sessionId/check-in ${plain} 1024`,
      `GET /v1/operator/events/:eventId/sessions ${plain} undefined`,
      `POST /v1/operator/scan/practice ${plain} 1024`,
      `POST /v1/operator/scan ${idempotent} 1024`,
    ]);
  });
});

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** The routes mounted without their guards, with the principal the guards would have set. */
async function mounted(
  register: (app: FastifyInstance) => void,
  principal: Readonly<{ role?: "owner" | "editor"; playerId?: string }>,
) {
  const app = Fastify();
  app.setErrorHandler((error: unknown, _request, reply) =>
    reply.code(error instanceof HttpError ? error.status : 500).send({
      code: error instanceof HttpError ? error.envelope.code : "unexpected",
    }),
  );
  app.addHook("onRequest", async (request) => {
    Object.assign(request, {
      staff: { account: { id: "staff-1", email: "o@x.sa" } },
      organizer: { id: "org-1", role: principal.role ?? "owner", eventScope: null },
      player: principal.playerId === undefined ? undefined : { id: principal.playerId },
    });
  });
  register(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("the owner routes' in-handler checks", () => {
  const operators = `/events/${ID}/operators`;
  const operatorBody = { abilities: [], canPlay: false, questIds: [] };

  it("passes isOwner from the caller's role to the list, so an editor never sees claim addresses", async () => {
    vi.mocked(listOperators).mockResolvedValue({ operators: [], invites: [] });
    for (const [role, isOwner] of [
      ["owner", true],
      ["editor", false],
    ] as const) {
      const app = await mounted((a) => registerOperatorRoutes(a, {} as never), { role });
      expect((await app.inject({ method: "GET", url: operators })).statusCode).toBe(200);
      expect(vi.mocked(listOperators).mock.lastCall?.[1]).toMatchObject({ isOwner, lang: "ar" });
      await app.close();
    }
  });

  it("answers 404 for an event the list cannot find", async () => {
    vi.mocked(listOperators).mockResolvedValue(null);
    const app = await mounted((a) => registerOperatorRoutes(a, {} as never), {});
    expect((await app.inject({ method: "GET", url: operators })).statusCode).toBe(404);
    await app.close();
  });

  it("refuses an implausible invite email with invalid_operator before creating anything", async () => {
    const app = await mounted((a) => registerOperatorRoutes(a, {} as never), {});
    const answer = await app.inject({
      method: "POST",
      url: `${operators}/invites`,
      payload: { kind: "email", email: "not an email" },
    });
    expect(answer.statusCode).toBe(422);
    expect(answer.json()).toEqual({ code: "invalid_operator" });
    expect(createInvites).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["creating invites", "POST", "/invites", { kind: "personal", label: "Door" }, createInvites],
    ["revoking an invite", "DELETE", `/invites/${OTHER}`, undefined, revokeInvite],
    ["changing an operator", "PUT", `/${OTHER}`, operatorBody, updateOperator],
    ["removing an operator", "DELETE", `/${OTHER}`, undefined, removeOperator],
  ] as const)(
    "answers owner_only when the store says %s is not the owner's",
    async (_what, method, path, payload, fn) => {
      vi.mocked(fn as (...args: never[]) => Promise<unknown>).mockResolvedValue(
        fn === createInvites ? { kind: "not_owner" } : "not_owner",
      );
      const app = await mounted((a) => registerOperatorRoutes(a, {} as never), { role: "editor" });
      const answer = await app.inject({
        method,
        url: `${operators}${path}`,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(answer.statusCode).toBe(403);
      expect(answer.json()).toEqual({ code: "owner_only" });
      await app.close();
    },
  );

  it("answers invalid_operator for a quest limit naming a quest outside the event", async () => {
    vi.mocked(updateOperator).mockResolvedValue("bad_quest");
    const app = await mounted((a) => registerOperatorRoutes(a, {} as never), {});
    const answer = await app.inject({
      method: "PUT",
      url: `${operators}/${OTHER}`,
      payload: operatorBody,
    });
    expect(answer.statusCode).toBe(422);
    expect(answer.json()).toEqual({ code: "invalid_operator" });
    await app.close();
  });
});

describe("the station-today route's hold-back", () => {
  const url = `/v1/operator/events/${ID}/stations/${OTHER}/today`;
  const deps = { pool: {}, keys: { playerKey: (id: string) => Buffer.from(id) } };
  const mountStation = () =>
    mounted((a) => registerOperatorPlayerRoutes(a, deps as unknown as OperatorPlayerDeps), {
      playerId: "player-9",
    });

  it("counts the operator's own read in the station-today bucket before reading", async () => {
    vi.mocked(stationToday).mockResolvedValue({ kind: "counts", today: 3, lastHour: 1 });
    const app = await mountStation();
    const answer = await app.inject({ method: "GET", url });
    expect(answer.json()).toEqual({ today: 3, lastHour: 1 });
    expect(holdBack).toHaveBeenCalledTimes(1);
    expect(vi.mocked(holdBack).mock.calls[0]?.slice(1, 3)).toEqual([
      [{ limit: STATION_TODAY_LIMIT, key: Buffer.from("player-9") }],
      true,
    ]);
    await app.close();
  });

  it("reads nothing when the hold-back refuses", async () => {
    vi.mocked(holdBack).mockRejectedValue(
      new HttpError(429, "too_many_attempts", { ar: "ب", en: "b" }),
    );
    const app = await mountStation();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(429);
    expect(stationToday).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [{ kind: "not_operator" }, 403, "not_operator"],
    [{ kind: "not_station" }, 404, undefined],
    [{ kind: "outside_station" }, 403, "outside_quests"],
  ] as const)("maps %j to %i", async (result, status, code) => {
    vi.mocked(stationToday).mockResolvedValue(result as never);
    const app = await mountStation();
    const answer = await app.inject({ method: "GET", url });
    expect(answer.statusCode).toBe(status);
    if (code !== undefined) {
      expect(answer.json()).toEqual({ code });
    }
    await app.close();
  });
});
