import { randomUUID } from "node:crypto";
import type { RedisClientType } from "redis";
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

/** KEYS: set, member, next, next:member, building. ARGV: enrollment, version, member, score, tomb, ttl. */
const WRITE = `${APPLY}
local applied = apply(KEYS[1], KEYS[2], ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6])
if redis.call('EXISTS', KEYS[5]) == 1 then
  apply(KEYS[3], KEYS[4], ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6])
end
return applied
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
 * KEYS: set, member, built. ARGV: size, enrollment (or ''). Returns nil when the copy is not built, else
 * {total, place or -1, member, score, member, score, ...} for the top.
 */
const READ = `
if redis.call('EXISTS', KEYS[3]) == 0 then return nil end
local total = redis.call('ZCARD', KEYS[1])
local place = -1
if ARGV[2] ~= '' then
  local stored = redis.call('HGET', KEYS[2], ARGV[2])
  if stored and string.sub(stored, 1, 1) == 'v' then
    local rank = redis.call('ZREVRANK', KEYS[1], string.sub(stored, 22))
    if rank then place = rank + 1 end
  end
end
local result = {total, place}
if tonumber(ARGV[1]) > 0 then
  local top = redis.call('ZRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1, 'REV', 'WITHSCORES')
  for i = 1, #top do result[#result + 1] = top[i] end
end
return result
`;

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

/**
 * The store over a connected node-redis client. Every call can reject (Redis down, a timeout); callers fall back to
 * PostgreSQL and mark the event for repair.
 */
export function createRankingStore(client: RedisClientType): RankingStore {
  const write = async (event: string, entry: Entry, tomb: boolean) => {
    const keys = keysOf(event);
    await client.eval(WRITE, {
      keys: [keys.set, keys.member, keys.next, keys.nextMember, keys.building],
      arguments: writeArgs(entry, tomb),
    });
  };

  const fill = async (event: string, entries: readonly RebuildEntry[]) => {
    const keys = keysOf(event);
    for (let start = 0; start < entries.length; start += FILL_CHUNK) {
      const chunk = entries.slice(start, start + FILL_CHUNK);
      const args = [String(TTL_MS)];
      for (const entry of chunk) {
        args.push(...writeArgs(entry, !entry.ranked).slice(0, 5));
      }
      await client.eval(FILL, { keys: [keys.next, keys.nextMember], arguments: args });
    }
  };

  return {
    upsert: (event, entry) => write(event, entry, false),
    remove: (event, enrollmentId, version) =>
      write(event, { enrollmentId, version, score: 0n }, true),
    read: async (event, size, enrollmentId) => {
      const keys = keysOf(event);
      const reply = await client.eval(READ, {
        keys: [keys.set, keys.member, keys.built],
        arguments: [String(size), enrollmentId ?? ""],
      });
      return parseRead(reply);
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
        await client.eval(SWAP, {
          keys: [keys.set, keys.member, keys.next, keys.nextMember, keys.built, keys.building],
          arguments: [String(Date.now()), String(TTL_MS)],
        });
        swapped = true;
        return "rebuilt";
      } finally {
        if (!swapped) {
          await client.del([keys.next, keys.nextMember, keys.building]);
        }
        await client.eval(UNLOCK, { keys: [keys.lock], arguments: [token] });
      }
    },
    builtAt: async (event) => {
      const value = await client.get(keysOf(event).built);
      return value === null ? undefined : Number(value);
    },
  };
}
