import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { holdBack } from "#src/devices/limits";
import { HttpError } from "#src/http-error";
import { DATA_EXPORT_OWN_LIMIT, registerDataExportRoutes } from "#src/privacy/data-export";

vi.mock("#src/devices/limits", () => ({ holdBack: vi.fn(async () => undefined) }));

const PLAYER = "6f1d2b3c-4a5e-4f60-8a71-92b3c4d5e6f7";
const playerKey = (id: string) => Buffer.from(`key:${id}`);

/** The route on a bare app: the player comes from a test header, the export door answers `answer`. */
function exportApp(answer: unknown[] | Error) {
  const query = vi.fn(async (sql: string) => {
    if (!sql.includes("own_data_export")) return { rows: [] };
    if (answer instanceof Error) throw answer;
    return { rows: answer };
  });
  const pool = { connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  const app = Fastify();
  app.setErrorHandler((error: unknown, _request, reply) =>
    error instanceof HttpError
      ? reply.code(error.status).send(error.envelope)
      : reply.code(500).send({ error: String(error) }),
  );
  app.addHook("onRequest", async (request) => {
    const id = request.headers["x-test-player"];
    if (typeof id === "string") request.player = { id };
  });
  registerDataExportRoutes(app, { pool, keys: { playerKey } });
  const post = (headers: Record<string, string> = { "x-test-player": PLAYER }) =>
    app.inject({ method: "POST", url: "/v1/me/data-export", headers });
  return { post, query };
}

const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("the player's own data export", () => {
  it("sends the file with no body as a download nothing keeps, after the player's limit", async () => {
    vi.mocked(holdBack).mockClear();
    const { post } = exportApp([{ r: { playerId: PLAYER } }]);
    const answer = await post();
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ playerId: PLAYER });
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    expect(vi.mocked(holdBack).mock.calls[0]?.slice(1, 3)).toEqual([
      [{ limit: DATA_EXPORT_OWN_LIMIT, key: playerKey(PLAYER) }],
      true,
    ]);
  });

  it("answers 401 without a player, before the limit", async () => {
    vi.mocked(holdBack).mockClear();
    const { post, query } = exportApp([]);
    expect((await post({})).statusCode).toBe(401);
    expect(holdBack).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("answers 404 to an account that is not active", async () => {
    const answer = await exportApp(refusal("DR404", "not active")).post();
    expect(answer.statusCode).toBe(404);
  });

  it("answers 429 with the database's wait, at least one second", async () => {
    const waited = await exportApp(refusal("DR429", "3600")).post();
    expect(waited.statusCode).toBe(429);
    expect(waited.headers["retry-after"]).toBe("3600");
    expect(waited.json()).toMatchObject({ details: { retryAfterSeconds: 3600 } });
    const garbled = await exportApp(refusal("DR429", "soon")).post();
    expect(garbled.headers["retry-after"]).toBe("1");
  });

  it("passes any other failure through as a server error", async () => {
    const answer = await exportApp(refusal("XX000", "boom")).post();
    expect(answer.statusCode).toBe(500);
    expect(answer.headers["retry-after"]).toBeUndefined();
  });
});
