import {
  createServer as createH2Server,
  constants,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CLOSE_WAIT_MS,
  createH2Client,
  MIN_WRITE_MS,
  RETIRE_GRACE_MS,
  retryAfterMs,
  type H2Answer,
  type H2Request,
} from "#src/push/h2";
import { PROVIDER_MARGIN_MS } from "#src/push/send";
import {
  startDeadPathProxy,
  startH2Server,
  type FakeH2,
  type Reply,
  type Seen,
} from "#test/support/h2-server";

const request: H2Request = {
  path: "/x",
  headers: { "content-type": "application/json" },
  body: "{}",
};
const soon = (ms = 2000): number => Date.now() + ms;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const notSent = (code: string): H2Answer => ({ kind: "not_sent", code });
const options = (origin: string, maxStreams = 10) => ({ origin, maxStreams, idleMs: 60_000 });
const accept = (): Reply => ({ status: 200 });

/** A request whose headers throw `thrown` when they are read. */
const throwing = (thrown: unknown): H2Request => ({
  ...request,
  headers: Object.defineProperty({}, "x-broken", {
    enumerable: true,
    get: () => {
      throw thrown;
    },
  }) as Record<string, string>,
});
const coded = (code: unknown) => Object.assign(new Error("no write"), { code });

/** Polls `check` every 10 ms until it holds, failing after 3 s. */
async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    if (check()) return;
    await pause(10);
  }
  throw new Error("the condition never held");
}

const listening = (server: Server, port: number, host?: string): Promise<number> =>
  new Promise((resolve) => {
    const ready = () => resolve((server.address() as AddressInfo).port);
    if (host === undefined) server.listen(port, ready);
    else server.listen(port, host, ready);
  });

const closing = (server: { close: (done: () => void) => unknown }): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

/** A local port nothing listens on. */
async function freePort(): Promise<number> {
  const spare = createServer();
  const port = await listening(spare, 0, "127.0.0.1");
  await closing(spare);
  return port;
}

/** Runs `work` with the process's uncaught exceptions held here; answers its value and what escaped. */
async function holdingEscapes<T>(
  work: () => Promise<T>,
): Promise<{ value: T; escaped: unknown[] }> {
  const escaped: unknown[] = [];
  const hold = (error: unknown): void => {
    escaped.push(error);
  };
  const listeners = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", hold);
  try {
    return { value: await work(), escaped };
  } finally {
    process.off("uncaughtException", hold);
    for (const listener of listeners) process.on("uncaughtException", listener);
  }
}

const TLS_HANDSHAKE = 22;
/** The ALPN extension offering `h2` alone: type 16, length 5, list length 3, then "h2" after its length. */
const ALPN_H2 = Buffer.from([0x00, 0x10, 0x00, 0x05, 0x00, 0x03, 0x02, 0x68, 0x32]);

/**
 * A TCP server on every local address that keeps the first TLS record each client sends (its ClientHello), then
 * drops the connection.
 */
async function startHelloTrap() {
  const hellos: Buffer[] = [];
  const sockets = new Set<Socket>();
  const trap = createServer((socket) => {
    sockets.add(socket);
    let read = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      read = Buffer.concat([read, chunk]);
      if (read.length < 5 || read.length < 5 + read.readUInt16BE(3)) return;
      hellos.push(read);
      socket.destroy();
    });
  });
  const port = await listening(trap, 0);
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await closing(trap);
  };
  return { port, hellos, close };
}

/** The most of an answer's body the client keeps (16 KB). */
const BODY_LIMIT = 16_384;

/** An HTTP/2 server that answers 200 with 16 KB of "a" and, 20 ms later, 16 KB of "b". */
async function startTwoChunkServer() {
  const server = createH2Server();
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => undefined);
  });
  server.on("stream", (stream: ServerHttp2Stream) => {
    stream.on("error", () => undefined);
    stream.respond({ ":status": 200 });
    stream.write(Buffer.alloc(BODY_LIMIT, "a"));
    setTimeout(() => stream.end(Buffer.alloc(BODY_LIMIT, "b")), 20);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  const close = async () => {
    for (const session of sessions) session.destroy();
    await closing(server);
  };
  return { origin: `http://127.0.0.1:${port}`, close };
}

/*
 * Equivalent mutants left alive (mutation run 40628312029): the clearTimeout in `by()` and at a stream's close, and
 * `waiting.clear()` (a leftover timer or waker only settles what is already settled); forceClose's `session.destroy()`
 * (destroying the socket ends the session too); the `session_error` fallback (Node's session errors carry a code); the
 * `stream.id === undefined` branch (a stream has its id once the server's settings arrived); `goawayLast !==
 * undefined` (no id is above undefined); replacesSession's `kind === "not_sent"` (only not_sent carries a code);
 * takeSlot's `return false` at the deadline (the MIN_WRITE_MS check refuses the same request); the `retired` flags,
 * sessionFor's closed check and the wake on close (each repeats another path: the GOAWAY handler or the close event
 * ends the session, and every stream's end wakes the waiters); `gone` resolving false (forcing a closed session does
 * nothing); retryAfterMs's empty-text guard (the patterns refuse an empty or absent text alike). `ALPNProtocols: [""]`
 * aborts Node itself (an assertion in its TLS code), so it shows as an error, not a survivor.
 */
describe("createH2Client", () => {
  let server: FakeH2;

  beforeAll(async () => {
    server = await startH2Server(() => ({ status: 200, body: { ok: true } }));
  });

  afterAll(async () => {
    await server.close();
  });

  it("answers with the status, the headers and the body", async () => {
    const client = createH2Client(options(server.origin));
    const answer = await client.post(request, soon());
    expect(answer).toMatchObject({ kind: "answer", status: 200, body: '{"ok":true}' });
    await client.close();
  });

  it("keeps the first 16 KB of a long body", async () => {
    const long = await startTwoChunkServer();
    const client = createH2Client(options(long.origin));
    const answer = await client.post(request, soon());
    expect(answer).toMatchObject({ kind: "answer", status: 200, body: "a".repeat(BODY_LIMIT) });
    await client.close();
    await long.close();
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
    const client = createH2Client(options(server.origin));
    expect(() => client.reconnect()).not.toThrow();
    await client.post(request, soon());
    client.reconnect();
    await client.post(request, soon());
    expect(server.sessions()).toBe(before + 2);
    await client.close();
    await client.close();
    expect(() => client.reconnect()).not.toThrow();
    expect(await client.post(request, soon())).toEqual(notSent("closed"));
  });

  it("writes nothing when the deadline has passed or is too near to answer by, and keeps the connection", async () => {
    const client = createH2Client(options(server.origin));
    const seen = server.seen.length;
    const before = server.sessions();
    expect(await client.post(request, Date.now() - 1)).toEqual(notSent("deadline"));
    expect(server.sessions()).toBe(before);
    await client.post(request, soon());
    expect(await client.post(request, Date.now() + MIN_WRITE_MS - 50)).toEqual(notSent("deadline"));
    await client.post(request, soon());
    expect(server.seen.length).toBe(seen + 2);
    expect(server.sessions()).toBe(before + 1);
    await client.close();
  });

  it("writes with MIN_WRITE_MS left and opens nothing at the deadline itself", async () => {
    const client = createH2Client(options(server.origin));
    const before = server.sessions();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await client.post(request, Date.now())).toEqual(notSent("deadline"));
      expect(server.sessions()).toBe(before);
      expect(await client.post(request, Date.now() + MIN_WRITE_MS)).toMatchObject({
        kind: "answer",
        status: 200,
      });
    } finally {
      vi.useRealTimers();
    }
    await client.close();
  });

  it("answers not_sent for a request it cannot write, with a code that fits push_send.code, and frees the stream", async () => {
    const client = createH2Client(options(server.origin, 1));
    expect(await client.post({ ...request, headers: { "bad header": "x" } }, soon())).toEqual(
      notSent("ERR_INVALID_HTTP_TOKEN"),
    );
    for (const thrown of [coded(7), coded("A".repeat(41)), coded("ERR-X"), undefined]) {
      expect(await client.post(throwing(thrown), soon())).toEqual(notSent("session_closed"));
    }
    expect(await client.post(request, soon())).toMatchObject({ kind: "answer", status: 200 });
    await client.close();
  });

  it("answers Node's code for a refused connection, lets no error escape, and dials again for the next request", async () => {
    const port = await freePort();
    const client = createH2Client(options(`http://127.0.0.1:${port}`));
    const started = Date.now();
    const refused = await holdingEscapes(() => client.post(request, soon(5000)));
    expect(refused).toEqual({ value: notSent("ECONNREFUSED"), escaped: [] });
    expect(Date.now() - started).toBeLessThan(5000);
    const late = await startH2Server(() => ({ status: 200 }), { port });
    expect(await client.post(request, soon())).toMatchObject({ kind: "answer", status: 200 });
    await client.close();
    await late.close();
  });
});

describe("streams and connections that end", () => {
  let server: FakeH2;
  let next: (seen: Seen) => Reply = accept;

  beforeAll(async () => {
    server = await startH2Server((seen) => next(seen), { maxConcurrentStreams: 1 });
  });

  afterEach(() => {
    server.seen.length = 0;
    next = accept;
  });

  afterAll(async () => {
    await server.close();
  });

  it("lets close() finish a stream in flight, returning as soon as the connection closes", async () => {
    next = () => ({ status: 200, delayMs: 300 });
    const client = createH2Client(options(server.origin));
    const answer = client.post(request, soon());
    await until(() => server.seen.length === 1);
    const started = Date.now();
    await client.close();
    expect(Date.now() - started).toBeLessThan(CLOSE_WAIT_MS);
    expect(await answer).toMatchObject({ kind: "answer", status: 200 });
  });

  it("gives a request waiting for a stream up at its deadline", async () => {
    next = (seen) => (seen.streamId === 1 ? { status: 200, delayMs: 1000 } : { status: 200 });
    const client = createH2Client(options(server.origin));
    const slow = client.post(request, soon(3000));
    const started = Date.now();
    expect(await client.post(request, soon(300))).toEqual(notSent("deadline"));
    expect(Date.now() - started).toBeLessThan(300 + PROVIDER_MARGIN_MS);
    expect(await slow).toMatchObject({ kind: "answer", status: 200 });
    await client.close();
  });

  it("writes a waiting request as soon as the server allows more streams", async () => {
    next = (seen) => {
      if (seen.streamId !== 1) return { status: 200 };
      server.allowStreams(10);
      return { status: 200, delayMs: 1500 };
    };
    const client = createH2Client(options(server.origin));
    const slow = client.post(request, soon(5000));
    expect(await client.post(request, soon(1000))).toMatchObject({ kind: "answer", status: 200 });
    expect(await slow).toMatchObject({ kind: "answer", status: 200 });
    await client.close();
  });

  it("sends a request that waited for a stream on a new connection when the old one ends", async () => {
    const first = server.sessions() + 1;
    next = (seen) =>
      seen.session === first
        ? { goaway: constants.NGHTTP2_INTERNAL_ERROR, last: 0 }
        : { status: 200 };
    const client = createH2Client(options(server.origin));
    const [ended, waited] = await Promise.all([
      client.post(request, soon()),
      client.post(request, soon()),
    ]);
    expect(ended.kind).not.toBe("answer");
    expect(waited).toMatchObject({ kind: "answer", status: 200 });
    expect(server.seen.map((one) => one.session)).toEqual([first, first + 1]);
    await client.close();
  });

  it("closes the replaced connection on reconnect() and keeps the new one once the old is gone", async () => {
    const first = server.sessions() + 1;
    const open = server.open();
    next = (seen) => (seen.session === first ? { status: 200, delayMs: 300 } : { status: 200 });
    const client = createH2Client(options(server.origin));
    const slow = client.post(request, soon());
    await until(() => server.seen.length === 1);
    client.reconnect();
    expect(await client.post(request, soon())).toMatchObject({ kind: "answer", status: 200 });
    expect(await slow).toMatchObject({ kind: "answer", status: 200 });
    await until(() => server.open() === open + 1);
    // The client sees the old connection close a moment after the server does.
    await pause(50);
    await client.post(request, soon());
    expect(server.seen.map((one) => one.session)).toEqual([first, first + 1, first + 1]);
    await client.close();
  });
});

describe("a connection that stops answering (a dead path)", () => {
  let server: FakeH2;

  beforeAll(async () => {
    server = await startH2Server(() => ({ status: 200 }));
  });

  afterAll(async () => {
    await server.close();
  });

  it("is replaced after a request lost on it, so the next request goes out on a new connection", async () => {
    const proxy = await startDeadPathProxy(server.origin);
    const client = createH2Client(options(proxy.origin));
    expect(await client.post(request, soon())).toMatchObject({ kind: "answer", status: 200 });
    proxy.drop();
    expect(await client.post(request, soon(400))).toEqual({ kind: "lost", code: "timeout" });
    expect(await client.post(request, soon())).toMatchObject({ kind: "answer", status: 200 });
    expect(await client.post(request, soon())).toMatchObject({ kind: "answer", status: 200 });
    expect(server.seen.map((one) => one.session)).toEqual([1, 2, 2]);
    await client.close();
    await proxy.close();
  });

  it("drops the replaced connection after the grace, when the far side never closes it", async () => {
    const proxy = await startDeadPathProxy(server.origin);
    const client = createH2Client(options(proxy.origin));
    expect(await client.post(request, soon())).toMatchObject({ kind: "answer", status: 200 });
    proxy.drop();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const lost = client.post(request, soon(1000));
      const state = { settled: false };
      void lost.then(() => {
        state.settled = true;
      });
      for (let step = 0; step < 100 && !state.settled; step += 1) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(await lost).toEqual({ kind: "lost", code: "timeout" });
      vi.advanceTimersByTime(RETIRE_GRACE_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(await proxy.released()).toBe(true);
    await client.close();
    await proxy.close();
  });

  it("does not hold close() when the far side never closes the connection", async () => {
    const proxy = await startDeadPathProxy(server.origin);
    const client = createH2Client(options(proxy.origin));
    await client.post(request, soon());
    proxy.drop();
    const started = Date.now();
    await client.close();
    expect(Date.now() - started).toBeLessThan(CLOSE_WAIT_MS + PROVIDER_MARGIN_MS);
    expect(await proxy.released()).toBe(true);
    await proxy.close();
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
    await listening(silent, 0, "127.0.0.1");
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await closing(silent);
  });

  it("answers not_sent by the deadline", async () => {
    const { port } = silent.address() as AddressInfo;
    const client = createH2Client(options(`http://127.0.0.1:${port}`));
    const started = Date.now();
    expect(await client.post(request, soon(300))).toEqual(notSent("connect_timeout"));
    expect(Date.now() - started).toBeLessThan(300 + PROVIDER_MARGIN_MS);
    client.reconnect();
  });

  it("answers connect_failed at once when the host closes the connection without a word", async () => {
    const curt = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.resume();
      socket.end();
    });
    const port = await listening(curt, 0, "127.0.0.1");
    const client = createH2Client(options(`http://127.0.0.1:${port}`));
    const started = Date.now();
    expect(await client.post(request, soon(5000))).toEqual(notSent("connect_failed"));
    expect(Date.now() - started).toBeLessThan(5000);
    await client.close();
    await closing(curt);
  });
});

describe("an https origin", () => {
  it("dials TLS offering h2, naming a host (never an IP address) for SNI", async () => {
    const trap = await startHelloTrap();
    for (const host of ["localhost", "127.0.0.1"]) {
      const client = createH2Client(options(`https://${host}:${trap.port}`));
      expect(await client.post(request, soon()), host).toEqual(notSent("ECONNRESET"));
      await client.close();
    }
    const [named, numeric] = trap.hellos;
    for (const hello of [named, numeric]) {
      expect(hello?.[0]).toBe(TLS_HANDSHAKE);
      expect(hello?.includes(ALPN_H2)).toBe(true);
    }
    expect(named?.includes(Buffer.from("localhost"))).toBe(true);
    expect(numeric?.includes(Buffer.from("127.0.0.1"))).toBe(false);
    await trap.close();
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");

  it("reads seconds and HTTP dates, never below zero", () => {
    expect(retryAfterMs("7", now)).toBe(7000);
    expect(retryAfterMs(" 7 ", now)).toBe(7000);
    expect(retryAfterMs(["2"], now)).toBe(2000);
    expect(retryAfterMs("Tue, 01 Jan 2030 00:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Mon, 31 Dec 2029 23:59:00 GMT", now)).toBe(0);
  });

  it("ignores an absent, empty or unreadable value", () => {
    expect(retryAfterMs(undefined, now)).toBeUndefined();
    expect(retryAfterMs(" ", now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs("-5", now)).toBeUndefined();
    expect(retryAfterMs("7 seconds", now)).toBeUndefined();
    expect(retryAfterMs("1234567890", now)).toBeUndefined();
  });

  it("takes a date only when it starts with the day's name", () => {
    expect(retryAfterMs("1 Jan 2030 00:00:30 GMT", now)).toBeUndefined();
    expect(retryAfterMs("x 01 Jan 2030 00:00:30 GMT", now)).toBeUndefined();
  });
});
