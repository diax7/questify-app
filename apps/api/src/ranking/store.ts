import { randomUUID } from "node:crypto";
import { createClient, defineScript, type CommandParser, type RedisClientOptions } from "redis";
import { memberOf, parseMember } from "#src/ranking/member";

/**
 * The live copy of each event's ranking in Redis (ADR-118). Per event, under one hash tag so every script's keys sit
 * together: the sorted set (points as the score, `memberOf` as the member), a hash from enrollment to what it holds
 * (`v{version} {member}`, or `x{version}` for a removal tombstone), `built` (when the copy was last rebuilt, in
 * milliseconds), and while a rebuild runs, `next`, `next:member` and `building`. Versions are ledger ids written as 19
 * fixed-width digits, so Lua compares them as strings (its numbers are doubles and would lose precision).
 */
export type RankingStore = Readonly<{
  /** Puts an enrollment at its points and version; a write with a version not higher than the stored one is ignored. */
  upsert: (event: string, entry: Entry) => Promise<void>;
  /**
   * `upsert` and then the enrollment's place in one call (ADR-673): the total and the place with no top, or undefined
   * when the copy is not built (the write is applied either way, as `upsert` then `read` did).
   */
  upsertRead: (event: string, entry: Entry) => Promise<Read | undefined>;
  /** Takes an enrollment out and leaves a tombstone at its version, so a late upsert cannot bring it back. */
  remove: (event: string, enrollmentId: string, version: bigint) => Promise<void>;
  /** The top of the copy and the given enrollment's place, or undefined when the copy is not built. */
  read: (
    event: string,
    size: number,
    enrollmentId: string | undefined,
  ) => Promise<Read | undefined>;
  /** Rebuilds the copy from these entries, unless another rebuild of the event holds the lock. */
  rebuild: (
    event: string,
    load: () => Promise<readonly RebuildEntry[]>,
  ) => Promise<"rebuilt" | "busy">;
  /** When the copy was last rebuilt (milliseconds), or undefined when it is not built. */
  builtAt: (event: string) => Promise<number | undefined>;
}>;

export type Entry = Readonly<{ enrollmentId: string; score: bigint; version: bigint }>;
export type RebuildEntry = Entry & Readonly<{ ranked: boolean }>;
export type Ranked = Readonly<{ enrollmentId: string; version: bigint; score: bigint }>;
export type Read = Readonly<{ top: readonly Ranked[]; total: number; place: number | null }>;

const VERSION_DIGITS = 19;
/** Every key of an event lives 30 days after its last write: the copy is rebuildable, and ended events fall away. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Long enough for a rebuild of the largest event (20,000 rows in a few hundred milliseconds), short enough to recover. */
const LOCK_MS = 30_000;
const FILL_CHUNK = 500;

const keysOf = (event: string) => {
  const tag = `rank:{${event}}`;
  return {
    set: tag,
    member: `${tag}:member`,
    next: `${tag}:next`,
    nextMember: `${tag}:next:member`,
    building: `${tag}:building`,
    built: `${tag}:built`,
    lock: `${tag}:lock`,
  };
};

const fixed = (version: bigint): string => version.toString().padStart(VERSION_DIGITS, "0");

/**
 * Applies one write to a set and its hash. An upsert needs a version higher than the stored one; a tombstone needs one
 * at least as high (a ban removes the member at its current version). Returns 1 when applied.
 */
const APPLY = `
local function apply(set, hash, enrollment, version, member, score, tomb, ttl)
  local stored = redis.call('HGET', hash, enrollment)
  if stored then
    local was = string.sub(stored, 2, 20)
    if (tomb == '1' and version < was) or (tomb ~= '1' and version <= was) then return 0 end
    if string.sub(stored, 1, 1) == 'v' then redis.call('ZREM', set, string.sub(stored, 22)) end
  end
  if tomb == '1' then
    redis.call('HSET', hash, enrollment, 'x' .. version)
  else
    redis.call('ZADD', set, score, member)
    redis.call('HSET', hash, enrollment, 'v' .. version .. ' ' .. member)
  end
  -- One lifetime for every key, refreshed together, so no key of a copy outlives the others.
  redis.call('PEXPIRE', set, ttl)
  redis.call('PEXPIRE', hash, ttl)
  return 1
end
`;

/** Applies a write to the copy and, while a rebuild runs, to the copy being built. Returns 1 when applied to the copy. */
const WRITE_BOTH = `
local function write(set, hash, nset, nhash, building, enrollment, version, member, score, tomb, ttl)
  local applied = apply(set, hash, enrollment, version, member, score, tomb, ttl)
  if redis.call('EXISTS', building) == 1 then
    apply(nset, nhash, enrollment, version, member, score, tomb, ttl)
  end
  return applied
end
`;

/**
 * Nil when the copy is not built, else {total, place or -1, member, score, member, score, ...} for the top `size`.
 */
const PEEK = `
local function peek(set, hash, built, size, enrollment)
  if redis.call('EXISTS', built) == 0 then return nil end
  local total = redis.call('ZCARD', set)
  local place = -1
  if enrollment ~= '' then
    local stored = redis.call('HGET', hash, enrollment)
    if stored and string.sub(stored, 1, 1) == 'v' then
      local rank = redis.call('ZREVRANK', set, string.sub(stored, 22))
      if rank then place = rank + 1 end
    end
  end
  local result = {total, place}
  if tonumber(size) > 0 then
    local top = redis.call('ZRANGE', set, 0, tonumber(size) - 1, 'REV', 'WITHSCORES')
    for i = 1, #top do result[#result + 1] = top[i] end
  end
  return result
end
`;

/** KEYS: set, member, next, next:member, building. ARGV: enrollment, version, member, score, tomb, ttl. */
const WRITE = `${APPLY}${WRITE_BOTH}
return write(KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6])
`;

/** KEYS: set, member, built. ARGV: size, enrollment (or ''). */
const READ = `${PEEK}
return peek(KEYS[1], KEYS[2], KEYS[3], ARGV[1], ARGV[2])
`;

/**
 * WRITE then READ of the written enrollment with no top, in one call (ADR-673). KEYS: the union of both, set, member,
 * next, next:member, building, built. ARGV: WRITE's.
 */
const WRITE_READ = `${APPLY}${WRITE_BOTH}${PEEK}
write(KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6])
return peek(KEYS[1], KEYS[2], KEYS[6], '0', ARGV[1])
`;

/** KEYS: next, next:member. ARGV: ttl, then groups of enrollment, version, member, score, tomb. */
const FILL = `${APPLY}
for i = 2, #ARGV, 5 do
  apply(KEYS[1], KEYS[2], ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3], ARGV[i + 4], ARGV[1])
end
return 1
`;

/**
 * KEYS: set, member, next, next:member, built, building. ARGV: now, ttl. Puts the rebuilt copy in place in one step;
 * an event with no one ranked (no next set) ends with an empty set.
 */
const SWAP = `
if redis.call('EXISTS', KEYS[3]) == 1 then redis.call('RENAME', KEYS[3], KEYS[1]) else redis.call('DEL', KEYS[1]) end
if redis.call('EXISTS', KEYS[4]) == 1 then redis.call('RENAME', KEYS[4], KEYS[2]) else redis.call('DEL', KEYS[2]) end
redis.call('SET', KEYS[5], ARGV[1], 'PX', ARGV[2])
redis.call('DEL', KEYS[6])
return 1
`;

/** KEYS: lock. ARGV: token. Releases the lock only when it is still ours. */
const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * A script with a fixed number of keys, called as `client.<name>(keys, args)`. node-redis sends `EVALSHA` with its
 * SHA1 and, when Redis answers NOSCRIPT (a restart, a flush, a new replica), sends the body once with `EVAL`.
 */
const script = (source: string, keyCount: number) =>
  defineScript({
    SCRIPT: source,
    NUMBER_OF_KEYS: keyCount,
    parseCommand(parser: CommandParser, keys: string[], args: string[]) {
      parser.pushKeys(keys);
      parser.push(...args);
    },
    transformReply: (reply: unknown) => reply,
  });

/** The ranking's scripts, loaded by name on the client (`createRankingRedis`). */
export const RANKING_SCRIPTS = {
  rankingWrite: script(WRITE, 5),
  rankingRead: script(READ, 3),
  rankingWriteRead: script(WRITE_READ, 6),
  rankingFill: script(FILL, 2),
  rankingSwap: script(SWAP, 6),
  rankingUnlock: script(UNLOCK, 1),
};

/** A node-redis client that carries the ranking's scripts. */
export function createRankingRedis(options: Omit<RedisClientOptions, "scripts">) {
  return createClient({ ...options, scripts: RANKING_SCRIPTS });
}

export type RankingRedis = ReturnType<typeof createRankingRedis>;

const writeArgs = (entry: Entry, tomb: boolean): string[] => [
  entry.enrollmentId,
  fixed(entry.version),
  memberOf(entry.version, entry.enrollmentId),
  entry.score.toString(),
  tomb ? "1" : "0",
  String(TTL_MS),
];

function parseRead(reply: unknown): Read | undefined {
  if (!Array.isArray(reply)) {
    return undefined;
  }
  const [total, place, ...pairs] = reply as Array<number | string>;
  const top: Ranked[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const parsed = parseMember(String(pairs[i]));
    if (parsed !== undefined) {
      // Points stay far below 2^53, where Redis would print a score in exponent form.
      top.push({ ...parsed, score: BigInt(String(pairs[i + 1])) });
    }
  }
  return { top, total: Number(total), place: Number(place) > 0 ? Number(place) : null };
}

/** The keys WRITE takes, in its order. */
const writeKeys = (event: string): string[] => {
  const keys = keysOf(event);
  return [keys.set, keys.member, keys.next, keys.nextMember, keys.building];
};

/**
 * The store over a connected client from `createRankingRedis`. Every call can reject (Redis down, a timeout); callers
 * fall back to PostgreSQL and mark the event for repair.
 */
export function createRankingStore(client: RankingRedis): RankingStore {
  const fill = async (event: string, entries: readonly RebuildEntry[]) => {
    const keys = keysOf(event);
    for (let start = 0; start < entries.length; start += FILL_CHUNK) {
      const chunk = entries.slice(start, start + FILL_CHUNK);
      const args = [String(TTL_MS)];
      for (const entry of chunk) {
        args.push(...writeArgs(entry, !entry.ranked).slice(0, 5));
      }
      await client.rankingFill([keys.next, keys.nextMember], args);
    }
  };

  return {
    upsert: async (event, entry) => {
      await client.rankingWrite(writeKeys(event), writeArgs(entry, false));
    },
    upsertRead: async (event, entry) =>
      parseRead(
        await client.rankingWriteRead(
          [...writeKeys(event), keysOf(event).built],
          writeArgs(entry, false),
        ),
      ),
    remove: async (event, enrollmentId, version) => {
      await client.rankingWrite(
        writeKeys(event),
        writeArgs({ enrollmentId, version, score: 0n }, true),
      );
    },
    read: async (event, size, enrollmentId) => {
      const keys = keysOf(event);
      return parseRead(
        await client.rankingRead(
          [keys.set, keys.member, keys.built],
          [String(size), enrollmentId ?? ""],
        ),
      );
    },
    rebuild: async (event, load) => {
      const keys = keysOf(event);
      const token = randomUUID();
      if ((await client.set(keys.lock, token, { NX: true, PX: LOCK_MS })) !== "OK") {
        return "busy";
      }
      let swapped = false;
      try {
        // Harmless unless a rebuild outlives its lock (30 s; a 20,000-row rebuild measured about 130 ms): a second
        // rebuild's DEL of `next` could then let the first publish a partial copy.
        await client.del([keys.next, keys.nextMember]);
        await client.set(keys.building, "1", { PX: LOCK_MS });
        await fill(event, await load());
        await client.rankingSwap(
          [keys.set, keys.member, keys.next, keys.nextMember, keys.built, keys.building],
          [String(Date.now()), String(TTL_MS)],
        );
        swapped = true;
        return "rebuilt";
      } finally {
        if (!swapped) {
          await client.del([keys.next, keys.nextMember, keys.building]);
        }
        await client.rankingUnlock([keys.lock], [token]);
      }
    },
    builtAt: async (event) => {
      const value = await client.get(keysOf(event).built);
      return value === null ? undefined : Number(value);
    },
  };
}
