import {
  createServer,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type Socket,
} from "node:net";

/** One request the fake provider read in full. */
export type Seen = Readonly<{
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** Which connection carried it, from 1. */
  session: number;
  streamId: number;
}>;

/**
 * How the fake answers a request, after reading all of it (so the request was written):
 * - a status with an optional JSON body and headers, after `delayMs`;
 * - `reset`: RST_STREAM with that HTTP/2 error code (7 is REFUSED_STREAM);
 * - `goaway`: GOAWAY on the connection with that code, saying `last` (default: the stream before this one) was the
 *   last stream processed;
 * - `hang`: never answers.
 */
export type Reply =
  | Readonly<{
      status: number;
      body?: unknown;
      headers?: Readonly<Record<string, string>>;
      delayMs?: number;
    }>
  | Readonly<{ reset: number }>
  | Readonly<{ goaway: number; last?: number }>
  | Readonly<{ hang: true }>;

export type FakeH2 = Readonly<{
  /** `http://127.0.0.1:<port>`: cleartext HTTP/2, the same frames as Apple's and Google's TLS hosts. */
  origin: string;
  seen: Seen[];
  /** Connections opened so far. */
  sessions: () => number;
  /** The most streams that were open at once. */
  maxOpen: () => number;
  /** Sends a new SETTINGS_MAX_CONCURRENT_STREAMS on every open connection. */
  allowStreams: (max: number) => void;
  close: () => Promise<void>;
}>;

function act(stream: ServerHttp2Stream, reply: Reply): void {
  if ("hang" in reply) return;
  if ("reset" in reply) {
    stream.close(reply.reset);
    return;
  }
  if ("goaway" in reply) {
    stream.session?.goaway(reply.goaway, reply.last ?? (stream.id ?? 2) - 2);
    return;
  }
  const respond = (): void => {
    if (stream.destroyed) return;
    stream.respond({ ":status": reply.status, ...reply.headers });
    stream.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
  };
  if (reply.delayMs === undefined) respond();
  else setTimeout(respond, reply.delayMs);
}

/**
 * A local HTTP/2 server that speaks a push provider's wire format for tests: it records each request and answers as
 * `reply` says (statuses with reason JSON, resets, GOAWAY, slow or no answers).
 */
export async function startH2Server(
  reply: (seen: Seen) => Reply | Promise<Reply>,
  options: Readonly<{ maxConcurrentStreams?: number }> = {},
): Promise<FakeH2> {
  const server = createServer({
    settings: { maxConcurrentStreams: options.maxConcurrentStreams ?? 1000 },
  });
  const open = new Map<ServerHttp2Session, number>();
  const seen: Seen[] = [];
  let sessions = 0;
  let streams = 0;
  let maxOpen = 0;
  server.on("session", (session) => {
    sessions += 1;
    open.set(session, sessions);
    session.on("error", () => undefined);
    session.once("close", () => open.delete(session));
  });
  server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    streams += 1;
    maxOpen = Math.max(maxOpen, streams);
    stream.once("close", () => {
      streams -= 1;
    });
    stream.on("error", () => undefined);
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const one: Seen = {
        path: String(headers[":path"]),
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
        session: open.get(stream.session as ServerHttp2Session) ?? 0,
        streamId: stream.id ?? 0,
      };
      seen.push(one);
      void Promise.resolve(reply(one)).then((answer) => act(stream, answer));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    sessions: () => sessions,
    maxOpen: () => maxOpen,
    allowStreams: (max) => {
      for (const session of open.keys()) session.settings({ maxConcurrentStreams: max });
    },
    close: async () => {
      for (const session of open.keys()) session.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export type DeadPathProxy = Readonly<{
  /** `http://127.0.0.1:<port>`: connections pass through to the target until `drop()`. */
  origin: string;
  /**
   * Turns every connection open now into a dead path: nothing more is carried either way and nothing is closed, as when
   * a NAT forgets the connection. Connections made later pass through.
   */
  drop: () => void;
  /**
   * Whether the client let go of every connection it made: a byte is sent back on each, and a socket the client
   * destroyed answers with a reset (a socket it only half-closed still takes it).
   */
  released: () => Promise<boolean>;
  close: () => Promise<void>;
}>;

/** A TCP proxy in front of `target` (a local test server's origin) that can silently drop its open connections. */
export async function startDeadPathProxy(target: string): Promise<DeadPathProxy> {
  const port = Number(new URL(target).port);
  const pairs: Array<{ dropped: boolean; client: Socket; upstream: Socket }> = [];
  const proxy = createNetServer({ allowHalfOpen: true }, (client) => {
    const upstream = netConnect({ host: "127.0.0.1", port, allowHalfOpen: true });
    const pair = { dropped: false, client, upstream };
    pairs.push(pair);
    const carry = (from: Socket, to: Socket): void => {
      from.on("data", (chunk: Buffer) => {
        if (!pair.dropped) to.write(chunk);
      });
      from.on("end", () => {
        if (!pair.dropped) to.end();
      });
      from.on("error", () => undefined);
    };
    carry(client, upstream);
    carry(upstream, client);
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const { port: own } = proxy.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${own}`,
    drop: () => {
      for (const pair of pairs) pair.dropped = true;
    },
    released: async () => {
      const closed = pairs.map(
        (pair) =>
          new Promise<boolean>((resolve) => {
            if (pair.client.destroyed) {
              resolve(true);
              return;
            }
            const timer = setTimeout(() => resolve(false), 1000);
            pair.client.once("close", () => {
              clearTimeout(timer);
              resolve(true);
            });
            pair.client.write("x");
            setTimeout(() => pair.client.write("x"), 100);
          }),
      );
      return (await Promise.all(closed)).every(Boolean);
    },
    close: async () => {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
      });
    },
  };
}
