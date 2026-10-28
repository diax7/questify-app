import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createH2Client, MIN_WRITE_MS, retryAfterMs, type H2Request } from "#src/push/h2";
import { startH2Server, type FakeH2 } from "#test/support/h2-server";

const request: H2Request = {
  path: "/x",
  headers: { "content-type": "application/json" },
  body: "{}",
};
const soon = (ms = 2000): number => Date.now() + ms;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createH2Client", () => {
  let server: FakeH2;

  beforeAll(async () => {
    server = await startH2Server(() => ({ status: 200, body: { ok: true } }));
  });

  afterAll(async () => {
    await server.close();
  });

  it("answers with the status, the headers and the body", async () => {
    const client = createH2Client({ origin: server.origin, maxStreams: 10, idleMs: 60_000 });
    const answer = await client.post(request, soon());
    expect(answer).toMatchObject({ kind: "answer", status: 200, body: '{"ok":true}' });
    await client.close();
  });

  it("closes a quiet connection after idleMs and opens a new one for the next request", async () => {
    const before = server.sessions();
    const client = createH2Client({ origin: server.origin, maxStreams: 10, idleMs: 100 });
    await client.post(request, soon());
    await client.post(request, soon());
    expect(server.sessions()).toBe(before + 1);
    await pause(300);
    await client.post(request, soon());
    expect(server.sessions()).toBe(before + 2);
    await client.close();
  });

  it("opens a new connection after reconnect(), and writes nothing once closed", async () => {
    const before = server.sessions();
    const client = createH2Client({ origin: server.origin, maxStreams: 10, idleMs: 60_000 });
    await client.post(request, soon());
    client.reconnect();
    await client.post(request, soon());
    expect(server.sessions()).toBe(before + 2);
    await client.close();
    await client.close();
    expect(await client.post(request, soon())).toEqual({ kind: "not_sent", code: "closed" });
  });

  it("writes nothing when the deadline has passed or is too near to answer by", async () => {
    const client = createH2Client({ origin: server.origin, maxStreams: 10, idleMs: 60_000 });
    const seen = server.seen.length;
    expect(await client.post(request, Date.now() - 1)).toEqual({
      kind: "not_sent",
      code: "deadline",
    });
    await client.post(request, soon());
    expect(await client.post(request, Date.now() + MIN_WRITE_MS - 50)).toEqual({
      kind: "not_sent",
      code: "deadline",
    });
    expect(server.seen.length).toBe(seen + 1);
    await client.close();
  });
});

describe("a host that accepts the connection but never speaks HTTP/2", () => {
  let silent: Server;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    silent = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      silent.close(() => resolve());
    });
  });

  it("answers not_sent by the deadline", async () => {
    const { port } = silent.address() as AddressInfo;
    const client = createH2Client({
      origin: `http://127.0.0.1:${port}`,
      maxStreams: 10,
      idleMs: 60_000,
    });
    const started = Date.now();
    expect(await client.post(request, soon(300))).toEqual({
      kind: "not_sent",
      code: "connect_timeout",
    });
    expect(Date.now() - started).toBeLessThan(300 + 150);
    client.reconnect();
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");

  it("reads seconds and HTTP dates, never below zero", () => {
    expect(retryAfterMs("7", now)).toBe(7000);
    expect(retryAfterMs(["2"], now)).toBe(2000);
    expect(retryAfterMs("Tue, 01 Jan 2030 00:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Mon, 31 Dec 2029 23:59:00 GMT", now)).toBe(0);
  });

  it("ignores an absent, empty or unreadable value", () => {
    expect(retryAfterMs(undefined, now)).toBeUndefined();
    expect(retryAfterMs(" ", now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs("-5", now)).toBeUndefined();
  });
});
