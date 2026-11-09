import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import type { Ranking } from "#src/ranking/ranking";
import { registerRankingRoutes } from "#src/ranking/routes";
import type { ConfigResult, SettingsService } from "#src/settings/service";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const SIGNED_IN = { "x-test-player": "yes" };
const ME = {
  rank: 2,
  username: "sara_k",
  fullName: null,
  avatar: "falcon",
  equipment: {},
  level: 3,
  score: 80,
};
const ROW = {
  rank: 1,
  username: "omar_t",
  fullName: null,
  avatar: "owl",
  equipment: {},
  hidden: false,
  level: 4,
  isMe: false,
  score: 90,
};
const VIEW = { rows: [ROW], me: ME, total: 2, today: true };

let app: FastifyInstance;
type Features = Record<string, { enabled: boolean }>;
type Read = (eventId: string, playerId: string, scope: string) => unknown;

/** The route over a configuration with these features and looks, and a ranking that answers `read`. */
function build(options: {
  config?: ConfigResult;
  features?: Features;
  hide?: boolean;
  read?: Read;
}) {
  const seen: unknown[][] = [];
  const config: ConfigResult =
    options.config ??
    ({
      kind: "ok",
      config: {
        features: options.features ?? {},
        layout: { looks: { ranking: { scores: options.hide === true ? "hidden" : "shown" } } },
      },
      etag: "x",
    } as unknown as ConfigResult);
  const settings = {
    forEvent: async (...args: unknown[]) => {
      seen.push(["config", ...args]);
      return config;
    },
  } as unknown as SettingsService;
  const ranking = {
    read: async (...args: [string, string, string]) => {
      seen.push(["read", ...args]);
      return (options.read ?? (() => VIEW))(...args);
    },
  } as unknown as Ranking;
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-test-player"] !== undefined) request.player = { id: PLAYER };
  });
  registerRankingRoutes(app, { ranking, settings });
  return { seen };
}

const get = (query = "", headers: Record<string, string> = SIGNED_IN) =>
  app.inject({ method: "GET", url: `/v1/events/${EVENT}/ranking${query}`, headers });
const codeOf = (response: { json: () => unknown }) => (response.json() as { code: string }).code;

afterEach(async () => {
  await app.close();
});

describe("GET /v1/events/:eventId/ranking", () => {
  it("answers the board with scores, reading the event scope by default", async () => {
    const { seen } = build({});
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...VIEW, scores: true });
    expect(seen).toEqual([
      ["config", EVENT, PLAYER],
      ["read", EVENT, PLAYER, "event"],
    ]);
  });

  it("answers 401 without a player, before reading anything", async () => {
    const { seen } = build({});
    const response = await get("", {});
    expect(response.statusCode).toBe(401);
    expect(seen).toEqual([]);
  });

  it("answers 400 for a bad scope or an event id that is no uuid", async () => {
    const { seen } = build({});
    expect((await get("?scope=week")).statusCode).toBe(400);
    expect((await get("?other=1")).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/v1/events/nope/ranking", headers: SIGNED_IN }))
        .statusCode,
    ).toBe(400);
    expect(seen).toEqual([]);
  });

  it("answers not_found when the event's configuration is not ok", async () => {
    const { seen } = build({ config: { kind: "not_found" } as unknown as ConfigResult });
    const response = await get();
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe("not_found");
    expect(seen).toEqual([["config", EVENT, PLAYER]]);
  });

  it("answers ranking_off when the ranking switch is off, today's or not, and nothing is read", async () => {
    const { seen } = build({ features: { ranking: { enabled: false } } });
    for (const query of ["", "?scope=today"]) {
      const response = await get(query);
      expect(response.statusCode).toBe(404);
      expect(codeOf(response)).toBe("ranking_off");
    }
    expect(seen.filter(([what]) => what === "read")).toEqual([]);
  });

  it("counts a ranking switch that is on, or not named, as on", async () => {
    build({ features: { ranking: { enabled: true }, rankingToday: { enabled: true } } });
    expect((await get("?scope=today")).statusCode).toBe(200);
  });

  it("answers today_ranking_off for the today scope while its switch is off, and still serves the event scope", async () => {
    const { seen } = build({ features: { rankingToday: { enabled: false } } });
    const response = await get("?scope=today");
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe("today_ranking_off");
    expect(seen.filter(([what]) => what === "read")).toEqual([]);
    const event = await get();
    expect(event.statusCode).toBe(200);
    expect(event.json()).toEqual({ ...VIEW, today: false, scores: true });
  });

  it("passes the today scope through and keeps `today` as the ranking said while the switch is on", async () => {
    const { seen } = build({
      read: (_event, _player, scope) => ({ ...VIEW, today: scope === "today" }),
    });
    const response = await get("?scope=today");
    expect(response.json()).toEqual({ ...VIEW, today: true, scores: true });
    expect(seen).toContainEqual(["read", EVENT, PLAYER, "today"]);
    expect((await get()).json()).toEqual({ ...VIEW, today: false, scores: true });
  });

  it("answers not_enrolled and today_ranking_off as the ranking says", async () => {
    build({ read: () => "not_enrolled" });
    const notEnrolled = await get();
    expect(notEnrolled.statusCode).toBe(403);
    expect(codeOf(notEnrolled)).toBe("not_enrolled");
    await app.close();
    build({ read: () => "today_off" });
    const todayOff = await get("?scope=today");
    expect(todayOff.statusCode).toBe(404);
    expect(codeOf(todayOff)).toBe("today_ranking_off");
  });

  it("sends no score when the event ranks places only", async () => {
    build({ hide: true });
    const body = (await get()).json() as { scores: boolean; rows: object[]; me: object };
    expect(body.scores).toBe(false);
    expect(JSON.stringify(body)).not.toContain('"score"');
    expect(body.rows).toHaveLength(1);
  });
});
