import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mediaBusy, notFound } from "#src/auth/http-errors";
import { etagMatches } from "#src/etag";
import { StorageError, type ObjectStore, type StoredBlob } from "#src/storage/client";

/** Media reads at a time and waiting, then 503 (plan review 86 MINOR 7; phase 3 tunes them from the load test). */
export const READ_ACTIVE = 8;
export const READ_WAITING = 128;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A media key exactly (m0001 `media_blob_key_shape`); anything else is a 404 before any other step. */
const KEY = new RegExp(`^o/${UUID}/e/${UUID}/[a-z]{2,20}/${UUID}\\.(jpg|png)$`);
const PREFIX = "/v1/media/";

export type ReadGate = Readonly<{
  /** Takes a place, or answers false when every place and every waiting place is taken. */
  enter: () => Promise<boolean>;
  leave: () => void;
}>;

/** A counting gate: `active` reads at once, `waiting` more in line, every later one refused at once. */
export function createReadGate(active = READ_ACTIVE, waiting = READ_WAITING): ReadGate {
  let running = 0;
  const line: Array<() => void> = [];
  return {
    enter: () => {
      if (running < active) {
        running += 1;
        return Promise.resolve(true);
      }
      if (line.length >= waiting) return Promise.resolve(false);
      return new Promise((resolve) => line.push(() => resolve(true)));
    },
    leave: () => {
      const next = line.shift();
      if (next === undefined) running -= 1;
      else next();
    },
  };
}

export type MediaRouteDeps = Readonly<{
  storage?: ObjectStore | undefined;
  gate?: ReadGate;
  now?: () => number;
}>;

const busy = mediaBusy;

/** The key a request names, only when its raw path is exactly `/v1/media/<key>` (no encoding, no extra segment). */
function keyOf(request: FastifyRequest): string | undefined {
  const path = request.url.split("?")[0] ?? "";
  if (!path.startsWith(PREFIX)) return undefined;
  const key = path.slice(PREFIX.length);
  return KEY.test(key) ? key : undefined;
}

const queryValue = (request: FastifyRequest, name: string): unknown =>
  (request.query as Record<string, unknown> | undefined)?.[name];

/** The bytes under the gate: a full gate or a media database that cannot answer is 503 with `Retry-After: 1`. */
async function read(
  deps: MediaRouteDeps & { gate: ReadGate },
  storage: ObjectStore,
  key: string,
  reply: FastifyReply,
): Promise<StoredBlob | undefined> {
  if (!(await deps.gate.enter())) {
    reply.header("retry-after", "1");
    throw busy();
  }
  try {
    return await storage.get(key);
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    reply.header("retry-after", "1");
    throw busy();
  } finally {
    deps.gate.leave();
  }
}

function answer(
  reply: FastifyReply,
  request: FastifyRequest,
  blob: StoredBlob,
  secondsLeft: number,
): FastifyReply {
  const etag = `"${blob.sha256.toString("base64url")}"`;
  reply
    .header("cache-control", `private, max-age=${secondsLeft}, immutable`)
    .header("etag", etag)
    .header("referrer-policy", "no-referrer")
    .header("cross-origin-resource-policy", "cross-origin")
    .header("content-security-policy", "default-src 'none'")
    .header("x-content-type-options", "nosniff")
    .header("accept-ranges", "none");
  if (etagMatches(request.headers["if-none-match"], etag)) return reply.code(304).send();
  return reply
    .header("content-type", blob.contentType)
    .header("content-disposition", "inline")
    .send(blob.body);
}

/**
 * The media route (ADR-840): `GET /v1/media/<key>?e=<expiry>&s=<signature>`, public because the link is the
 * authorization. Every refusal (a path that is not a key, a bad, old or too long link, no such bytes, no media store)
 * is the same 404, decided before any database read except the last. No address limit (plan review 86 MAJOR 2: a
 * venue's phones share one NAT). Fastify answers HEAD from the same handler.
 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  const gated = { ...deps, gate: deps.gate ?? createReadGate() };
  const now = deps.now ?? Date.now;
  app.get(`${PREFIX}*`, { config: { access: "public" } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const key = keyOf(request);
    const storage = deps.storage;
    const expiry = queryValue(request, "e");
    if (key === undefined || storage === undefined) throw notFound();
    if (!storage.checkLink(key, expiry, queryValue(request, "s"))) throw notFound();
    const blob = await read(gated, storage, key, reply);
    if (blob === undefined) throw notFound();
    const left = Math.max(1, Math.min(300, Number(expiry) - Math.floor(now() / 1000)));
    return answer(reply, request, blob, left);
  });
}
