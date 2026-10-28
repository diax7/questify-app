import {
  connect,
  constants,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
} from "node:http2";

/** The most of an answer's body kept: the providers' error bodies are a few hundred bytes. */
const BODY_LIMIT = 16_384;
/**
 * A request is written only with at least this long left: with less it would almost surely time out after the write
 * and count as `unknown` (never sent again), where not writing it lets a later claim send it.
 */
export const MIN_WRITE_MS = 200;
/** A code copied from Node or a provider must fit `push_send.code` (migration 0076); anything else becomes `fallback`. */
const CODE = /^[A-Za-z0-9_]{1,40}$/;

export type H2Request = Readonly<{
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

/**
 * What came of one request (ADR-345 (4)):
 * - `answer`: the server answered with a status (the body may be cut at 16 KB).
 * - `not_sent`: the request was never written, or the server said it never processed it (`REFUSED_STREAM`, a stream
 *   above a `GOAWAY`'s last stream id); sending it again cannot duplicate it.
 * - `lost`: written, then a timeout or a reset before any answer: the server may have acted on it.
 */
export type H2Answer =
  | Readonly<{ kind: "answer"; status: number; headers: IncomingHttpHeaders; body: string }>
  | Readonly<{ kind: "not_sent"; code: string }>
  | Readonly<{ kind: "lost"; code: string }>;

export type H2Options = Readonly<{
  /** `https://host` in production; a test gives a local cleartext `http://127.0.0.1:port`. */
  origin: string;
  /** The most streams in flight; never above the server's own `SETTINGS_MAX_CONCURRENT_STREAMS`. */
  maxStreams: number;
  /** A session with no traffic for this long is closed; the next request opens a fresh one. */
  idleMs: number;
}>;

export type H2Client = Readonly<{
  /** Posts one request on the shared session and answers by `until` (wall-clock ms). Never throws. */
  post: (request: H2Request, until: number) => Promise<H2Answer>;
  /** Lets the current session finish its streams; the next request opens a new one. */
  reconnect: () => void;
  /** Closes the session once its streams end; later requests answer `not_sent`. */
  close: () => Promise<void>;
}>;

/** One HTTP/2 session and the streams it carries. */
type Live = {
  readonly session: ClientHttp2Session;
  /** True once the server's settings arrived; false when the session ended first. */
  readonly ready: Promise<boolean>;
  inFlight: number;
  /** Requests waiting for a free stream; each is woken to look again. */
  readonly waiting: Set<(awake: boolean) => void>;
  /** The last stream id a `GOAWAY` said the server processed. */
  goawayLast: number | undefined;
  /** Node's code for the error that ended the session, when one did. */
  failure: string | undefined;
};

type Reply = {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  chunks: Buffer[];
  size: number;
  timedOut: boolean;
};

const notSent = (code: string): H2Answer => ({ kind: "not_sent", code });

/** A Node error's code when it fits a send's code column, else `fallback`. */
function codeOf(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && CODE.test(code) ? code : fallback;
}

/** `promise`'s value, or `late` once the wall clock reaches `until`. */
function by<T, L>(promise: Promise<T>, until: number, late: L): Promise<T | L> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<L>((resolve) => {
    timer = setTimeout(() => resolve(late), Math.max(0, until - Date.now()));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function wakeAll(live: Live): void {
  const waiting = [...live.waiting];
  live.waiting.clear();
  for (const wake of waiting) wake(true);
}

/** Opens a session; `ended` is told when it can take no new stream (a `GOAWAY`, an error, the close). */
function openSession(options: H2Options, ended: (live: Live) => void): Live {
  const session = connect(options.origin);
  const live: Live = {
    session,
    ready: new Promise<boolean>((resolve) => {
      session.once("remoteSettings", () => resolve(true));
      session.once("close", () => resolve(false));
    }),
    inFlight: 0,
    waiting: new Set(),
    goawayLast: undefined,
    failure: undefined,
  };
  session.on("remoteSettings", () => wakeAll(live));
  // The close that follows an error ends every stream, and each answers with what it saw.
  session.on("error", (error: unknown) => {
    live.failure = codeOf(error, "session_error");
  });
  session.on("goaway", (_code: number, lastStreamID: number) => {
    live.goawayLast = lastStreamID;
    ended(live);
  });
  session.once("close", () => {
    ended(live);
    wakeAll(live);
  });
  session.setTimeout(options.idleMs, () => session.close());
  return live;
}

const streamLimit = (live: Live, max: number): number =>
  Math.min(max, live.session.remoteSettings.maxConcurrentStreams ?? max);

/** Waits for a free stream within the server's limit; false at `until` or when the session ends meanwhile. */
async function takeSlot(live: Live, max: number, until: number): Promise<boolean> {
  for (;;) {
    if (live.session.closed) return false;
    if (live.inFlight < streamLimit(live, max)) break;
    const woken = new Promise<boolean>((resolve) => {
      live.waiting.add(resolve);
    });
    if (!(await by(woken, until, false))) return false;
  }
  live.inFlight += 1;
  return true;
}

function releaseSlot(live: Live): void {
  live.inFlight -= 1;
  wakeAll(live);
}

/** How a stream ended: an answer when a status came, else whether the server can have processed it. */
function ending(live: Live, stream: ClientHttp2Stream, reply: Reply): H2Answer {
  if (reply.status !== undefined) {
    return {
      kind: "answer",
      status: reply.status,
      headers: reply.headers,
      body: Buffer.concat(reply.chunks).toString("utf8"),
    };
  }
  if (reply.timedOut) return { kind: "lost", code: "timeout" };
  if (stream.id === undefined) return notSent(live.failure ?? "session_closed");
  if (live.goawayLast !== undefined && stream.id > live.goawayLast) return notSent("goaway");
  if (stream.rstCode === constants.NGHTTP2_REFUSED_STREAM) return notSent("refused_stream");
  return { kind: "lost", code: "reset" };
}

/** Writes one request on a taken slot and waits for its end, cancelling the stream at `until`. */
function exchange(live: Live, request: H2Request, until: number): Promise<H2Answer> {
  return new Promise((resolve) => {
    let stream: ClientHttp2Stream;
    try {
      stream = live.session.request({
        ":method": "POST",
        ":path": request.path,
        ...request.headers,
      });
    } catch (error) {
      releaseSlot(live);
      resolve(notSent(codeOf(error, "session_closed")));
      return;
    }
    const reply: Reply = { status: undefined, headers: {}, chunks: [], size: 0, timedOut: false };
    const timer = setTimeout(
      () => {
        reply.timedOut = true;
        stream.close(constants.NGHTTP2_CANCEL);
      },
      Math.max(0, until - Date.now()),
    );
    stream.on("response", (headers) => {
      reply.status = Number(headers[":status"]);
      reply.headers = headers;
    });
    stream.on("data", (chunk: Buffer) => {
      if (reply.size >= BODY_LIMIT) return;
      reply.chunks.push(chunk);
      reply.size += chunk.length;
    });
    // A stream error is followed by its close, which reports what the stream saw.
    stream.on("error", () => undefined);
    stream.once("close", () => {
      clearTimeout(timer);
      releaseSlot(live);
      resolve(ending(live, stream, reply));
    });
    stream.end(request.body);
  });
}

/**
 * Writes the request on a free stream of `live` and waits for its end; `not_sent` at the deadline or with too little
 * time left to answer, null when the session ended while waiting for a stream.
 */
async function writeOn(
  live: Live,
  request: H2Request,
  until: number,
  max: number,
): Promise<H2Answer | null> {
  if (!(await takeSlot(live, max, until))) {
    return live.session.closed ? null : notSent("deadline");
  }
  if (until - Date.now() < MIN_WRITE_MS) {
    releaseSlot(live);
    return notSent("deadline");
  }
  return exchange(live, request, until);
}

/**
 * One reused HTTP/2 session to one origin (ADR-344): opened on first use, reopened after a `GOAWAY`, an error, a
 * refused stream or `reconnect()`, closed after `idleMs` without traffic and on `close()`. At most `maxStreams` streams
 * are in flight, and never more than the server allows (APNs allows one until a token is accepted); a request waits
 * for a free stream until its deadline. Each answer says whether the request can have been processed, so a caller
 * sends again only what never arrived.
 */
export function createH2Client(options: H2Options): H2Client {
  let current: Live | undefined;
  let closed = false;
  const ended = (live: Live): void => {
    if (current === live) current = undefined;
  };
  const retire = (live: Live | undefined): void => {
    if (live === undefined) return;
    ended(live);
    live.session.close();
  };

  /** The live session, ready for streams, or why the request cannot be written. */
  const sessionFor = async (until: number): Promise<Live | H2Answer> => {
    if (current?.session.closed === true) retire(current);
    current ??= openSession(options, ended);
    const live = current;
    const ready = await by(live.ready, until, undefined);
    if (ready === undefined) return notSent("connect_timeout");
    return ready ? live : notSent(live.failure ?? "connect_failed");
  };

  const post = async (request: H2Request, until: number): Promise<H2Answer> => {
    for (;;) {
      if (closed) return notSent("closed");
      if (Date.now() >= until) return notSent("deadline");
      const live = await sessionFor(until);
      if (!("session" in live)) return live;
      const answer = await writeOn(live, request, until, options.maxStreams);
      // null: the session ended while the request waited for a stream, so a fresh one is tried.
      if (answer === null) continue;
      if (answer.kind === "not_sent" && answer.code === "refused_stream") retire(live);
      return answer;
    }
  };

  return {
    post,
    reconnect: () => retire(current),
    close: async () => {
      closed = true;
      const live = current;
      current = undefined;
      if (live === undefined || live.session.destroyed) return;
      const done = new Promise<void>((resolve) => {
        live.session.once("close", () => resolve());
      });
      live.session.close();
      await done;
    },
  };
}

/** A `Retry-After` header (seconds or an HTTP date) as milliseconds from `now`, or undefined when absent or unreadable. */
export function retryAfterMs(
  value: string | string[] | undefined,
  now: number,
): number | undefined {
  const text = (Array.isArray(value) ? value[0] : value)?.trim();
  if (text === undefined || text === "") return undefined;
  if (/^[0-9]{1,9}$/.test(text)) return Number(text) * 1000;
  // Every HTTP date form starts with the day's name; Date.parse alone would read "-5" as a year.
  if (!/^[A-Za-z]{3}/.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
