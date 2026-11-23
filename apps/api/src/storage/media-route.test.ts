import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { StorageError, type ObjectStore, type StoredBlob } from "#src/storage/client";
import { createMediaStore } from "#src/storage/media-store";
import { createReadGate, registerMediaRoutes, type ReadGate } from "#src/storage/media-route";
import { recordTelemetry, type Recording } from "#test/support/telemetry";

const KEY =
  "o/11111111-1111-4111-8111-111111111111/e/22222222-2222-4222-8222-222222222222/submission/33333333-3333-4333-8333-333333333333.jpg";
const BLOB: StoredBlob = {
  contentType: "image/jpeg",
  bytes: 4,
  sha256: Buffer.alloc(32, 7),
  body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
};
const NOW = 1_800_000_000_000;

type Reads = { count: number };

/** A real store's links over a fake read: `read` answers what the media database would. */
function storeWith(read: () => Promise<StoredBlob | undefined>, reads: Reads): ObjectStore {
  const real = createMediaStore({} as Pool, {
    origin: "https://api.example.test",
    secret: "r".repeat(32),
    now: () => NOW,
  });
  return {
    ...real,
    get: () => {
      reads.count += 1;
      return read();
    },
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(storage: ObjectStore | undefined, gate?: ReadGate): Promise<FastifyInstance> {
  app = Fastify();
  registerConventions(app, {
    idempotencyStore: new MemoryIdempotencyStore(),
    minAppVersion: "1.0.0",
  });
  registerMediaRoutes(app, { storage, now: () => NOW, ...(gate === undefined ? {} : { gate }) });
  await app.ready();
  return app;
}

const pathOf = (storage: ObjectStore, key = KEY, ttl = 300) => {
  const url = new URL(storage.signGet(key, ttl).url);
  return `${url.pathname}${url.search}`;
};

/** The media route (ADR-840): its headers, its one 404, the gate, no address limit, HEAD and 304. */
describe("the media route", () => {
  it("serves a good link with every header of the plan", async () => {
    const reads = { count: 0 };
    const storage = storeWith(async () => BLOB, reads);
    const served = await (await serve(storage)).inject({ method: "GET", url: pathOf(storage) });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(BLOB.body)).toBe(true);
    expect(served.headers).toMatchObject({
      "content-type": "image/jpeg",
      "content-length": "4",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "cache-control": "private, max-age=300, immutable",
      etag: `"${BLOB.sha256.toString("base64url")}"`,
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "cross-origin",
      "accept-ranges": "none",
    });
    expect(String(served.headers["content-security-policy"])).toMatch(/^default-src 'none'/);
    const short = await app?.inject({ method: "GET", url: pathOf(storage, KEY, 120) });
    expect(short?.headers["cache-control"]).toBe("private, max-age=120, immutable");
  });

  it("answers 304 to its own ETag, and HEAD without a body", async () => {
    const storage = storeWith(async () => BLOB, { count: 0 });
    const server = await serve(storage);
    const etag = `"${BLOB.sha256.toString("base64url")}"`;
    const again = await server.inject({
      method: "GET",
      url: pathOf(storage),
      headers: { "if-none-match": etag },
    });
    expect([again.statusCode, again.body]).toEqual([304, ""]);
    for (const header of [`W/${etag}`, `"other", ${etag}`, "*"]) {
      const listed = await server.inject({
        method: "GET",
        url: pathOf(storage),
        headers: { "if-none-match": header },
      });
      expect([header, listed.statusCode]).toEqual([header, 304]);
    }
    const stale = await server.inject({
      method: "GET",
      url: pathOf(storage),
      headers: { "if-none-match": '"other"' },
    });
    expect(stale.statusCode).toBe(200);
    const head = await server.inject({ method: "HEAD", url: pathOf(storage) });
    expect([head.statusCode, head.body, head.headers["content-type"]]).toEqual([
      200,
      "",
      "image/jpeg",
    ]);
  });

  it("answers one 404 for every refusal, with the same body and no database read before the link passes", async () => {
    const reads = { count: 0 };
    const storage = storeWith(async () => undefined, reads);
    const server = await serve(storage);
    const good = pathOf(storage);
    const [path, query] = good.split("?");
    const other = KEY.replace(
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    );
    const refusals = [
      String(path),
      `/v1/media/${other}?${query}`,
      `${path}?${String(query).replace(/s=./, "s=A")}`,
      `${path}?e=${NOW / 1000 + 3600}&s=${new URL(storage.signGet(KEY, 300).url).searchParams.get("s")}`,
      `/v1/media/${KEY.replace(/\//g, "%2f")}?${query}`,
      `/v1/media//${KEY}?${query}`,
      `/v1/media/${KEY}/extra?${query}`,
      `/v1/media/${KEY.toUpperCase()}?${query}`,
    ];
    const bodies = new Set<string>();
    for (const url of refusals) {
      const refused = await server.inject({ method: "GET", url });
      expect(refused.statusCode, url).toBe(404);
      expect(refused.headers["cache-control"], url).toBe("no-store");
      bodies.add(refused.body);
      expect(reads.count, url).toBe(0);
    }
    expect(reads.count).toBe(0);
    const missing = await server.inject({ method: "GET", url: good });
    expect(missing.statusCode).toBe(404);
    bodies.add(missing.body);
    expect(reads.count).toBe(1);
    expect(bodies.size).toBe(1);
    expect(await (await serve(undefined)).inject({ method: "GET", url: good })).toMatchObject({
      statusCode: 404,
    });
  });

  it("answers 503 with Retry-After when the gate is full or the media database is down", async () => {
    const storage = storeWith(async () => BLOB, { count: 0 });
    const full = await serve(storage, { enter: async () => false, leave: () => undefined });
    const busy = await full.inject({ method: "GET", url: pathOf(storage) });
    expect([busy.statusCode, busy.headers["retry-after"], busy.json().code]).toEqual([
      503,
      "1",
      "media_busy",
    ]);
    await app?.close();
    const down = storeWith(
      async () => {
        throw new StorageError("get", "unavailable");
      },
      { count: 0 },
    );
    const failed = await (await serve(down)).inject({ method: "GET", url: pathOf(down) });
    expect([failed.statusCode, failed.headers["retry-after"]]).toEqual([503, "1"]);
  });

  it("never limits by address: a hundred bad links from one address leave a good one served", async () => {
    const storage = storeWith(async () => BLOB, { count: 0 });
    const server = await serve(storage);
    for (let n = 0; n < 100; n += 1) {
      const bad = await server.inject({
        method: "GET",
        url: `/v1/media/${KEY}?e=1&s=${"A".repeat(22)}`,
      });
      expect(bad.statusCode).toBe(404);
    }
    expect((await server.inject({ method: "GET", url: pathOf(storage) })).statusCode).toBe(200);
  });
});

describe("the read gate", () => {
  it("lets its places in, queues the next ones up to its line, refuses the rest, and lets the line in as places free", async () => {
    const gate = createReadGate(2, 1);
    expect(await gate.enter()).toBe(true);
    expect(await gate.enter()).toBe(true);
    const waiting = gate.enter();
    expect(await gate.enter()).toBe(false);
    gate.leave();
    expect(await waiting).toBe(true);
    gate.leave();
    gate.leave();
    expect(await gate.enter()).toBe(true);
  });
});

describe("the media read counter", () => {
  let recording: Recording;
  beforeEach(() => {
    recording = recordTelemetry();
  });
  afterEach(async () => {
    await recording.shutdown();
  });

  it("counts every read by how it ended: ok, not_modified, refused, busy, unavailable", async () => {
    const storage = storeWith(async () => BLOB, { count: 0 });
    const server = await serve(storage);
    const etag = `"${BLOB.sha256.toString("base64url")}"`;
    await server.inject({ method: "GET", url: pathOf(storage) });
    await server.inject({ method: "GET", url: pathOf(storage) });
    await server.inject({
      method: "GET",
      url: pathOf(storage),
      headers: { "if-none-match": etag },
    });
    await server.inject({ method: "GET", url: `/v1/media/${KEY}?e=1&s=${"A".repeat(22)}` });
    await server.inject({ method: "GET", url: "/v1/media/not-a-key" });
    await app?.close();
    const empty = storeWith(async () => undefined, { count: 0 });
    await (await serve(empty)).inject({ method: "GET", url: pathOf(empty) });
    await app?.close();
    const full = await serve(storage, { enter: async () => false, leave: () => undefined });
    await full.inject({ method: "GET", url: pathOf(storage) });
    await app?.close();
    const down = storeWith(
      async () => {
        throw new StorageError("get", "unavailable");
      },
      { count: 0 },
    );
    await (await serve(down)).inject({ method: "GET", url: pathOf(down) });
    const points = (await recording.metrics()).get("questify.media.reads") ?? [];
    expect(
      Object.fromEntries(
        points.map((point) => [point.attributes["questify.outcome"], point.value]),
      ),
    ).toEqual({ ok: 2, not_modified: 1, refused: 3, busy: 1, unavailable: 1 });
  });
});
