import { WORD_LANGUAGES, WORD_MATCHES } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import {
  addAllowWord,
  readAllowWords,
  removeAllowWord,
} from "#src/console/players/name-allow-doors";
import { reasonOf, type ConsolePlayerDeps } from "#src/console/players/routes";
import { throttled } from "#src/console/throttle";
import {
  addWord,
  changeStanding,
  readRetired,
  readWords,
  removeWord,
  unretire,
} from "#src/console/players/safety-doors";
import type { DeviceLimit } from "#src/devices/limits";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const change = { config: { access: "admin", idempotent: true }, bodyLimit: 8192 } as const;

/** 20 bans and lifts an hour per admin, together. */
export const CONSOLE_BAN_LIMIT = {
  bucket: BUCKETS.consolePlayerBan,
  max: 20,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;
/** 120 word-list and allow-list reads a minute per admin, together. */
export const CONSOLE_WORDS_READ_LIMIT = {
  bucket: BUCKETS.consoleWords,
  max: 120,
  windowSeconds: 60,
} as const satisfies DeviceLimit;
/** 60 word-list, allow-list and retired-name changes an hour per admin, together. */
export const CONSOLE_WORDS_WRITE_LIMIT = {
  bucket: BUCKETS.consoleWordsWrite,
  max: 60,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

const playerParams = z.object({ playerId: z.uuid() });
const wordsQuery = z.strictObject({
  q: z.string().max(60).optional(),
  language: z.enum(WORD_LANGUAGES).optional(),
  match: z.enum(WORD_MATCHES).optional(),
  after: z.string().min(1).max(60).optional(),
});
const retiredQuery = z.strictObject({
  q: z.string().max(60).optional(),
  after: z.string().min(1).max(60).optional(),
});
const wordBody = z.strictObject({
  word: z.string().min(1).max(60),
  match: z.enum(WORD_MATCHES),
  language: z.enum(WORD_LANGUAGES),
});
const wordParams = z.object({ word: z.string().min(1).max(60) });
const allowQuery = z.strictObject({
  q: z.string().max(60).optional(),
  language: z.enum(WORD_LANGUAGES).optional(),
  after: z.string().min(1).max(60).optional(),
});
const allowBody = z.strictObject({ word: z.string().min(1).max(60) });
const releaseBody = z.strictObject({ username: z.string().min(1).max(120) });

function registerStanding(scope: FastifyInstance, deps: ConsolePlayerDeps): void {
  scope.post("/players/:playerId/ban", change, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const reason = reasonOf("ban", request.body);
    const who = await throttled(deps, request, reply, CONSOLE_BAN_LIMIT);
    const actionId = await changeStanding(
      deps.pool,
      who,
      { ...reason, playerId, to: "ban" },
      request.id,
    );
    return { actionId };
  });

  scope.post("/players/:playerId/lift-ban", change, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const reason = reasonOf("lift_ban", request.body);
    const who = await throttled(deps, request, reply, CONSOLE_BAN_LIMIT);
    const actionId = await changeStanding(
      deps.pool,
      who,
      { ...reason, playerId, to: "lift" },
      request.id,
    );
    return { actionId };
  });
}

function registerWords(scope: FastifyInstance, deps: ConsolePlayerDeps): void {
  scope.get("/words", read, async (request, reply) => {
    const query = parse(wordsQuery, request.query);
    const who = await throttled(deps, request, reply, CONSOLE_WORDS_READ_LIMIT);
    return readWords(deps.pool, who, {
      q: query.q ?? null,
      language: query.language ?? null,
      match: query.match ?? null,
      after: query.after ?? null,
    });
  });

  scope.post("/words", change, async (request, reply) => {
    const body = parse(wordBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_WORDS_WRITE_LIMIT);
    await addWord(deps.pool, who, body, request.id);
    return reply.code(201).send({ word: body.word });
  });

  scope.delete("/words/:word", change, async (request, reply) => {
    const { word } = parse(wordParams, request.params);
    const who = await throttled(deps, request, reply, CONSOLE_WORDS_WRITE_LIMIT);
    await removeWord(deps.pool, who, word, request.id);
    return reply.code(204).send();
  });

  scope.get("/retired-usernames", read, async (request, reply) => {
    const query = parse(retiredQuery, request.query);
    const who = await throttled(deps, request, reply, CONSOLE_WORDS_READ_LIMIT);
    return {
      names: await readRetired(deps.pool, who, { q: query.q ?? null, after: query.after ?? null }),
    };
  });

  // A retired name was a player's: it travels in the body, never the URL, so no access log holds it.
  scope.post("/retired-usernames/release", change, async (request, reply) => {
    const { username } = parse(releaseBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_WORDS_WRITE_LIMIT);
    await unretire(deps.pool, who, username, request.id);
    return reply.code(204).send();
  });
}

/**
 * The full-name allow-list (FR-1779, ADR-817, migration 0185): words of real names the full-name check skips. The same
 * seats, limits and Idempotency-Key as the word lists; an allow word is a list entry, not a player's, so it may sit in the
 * URL of its removal.
 */
function registerNameAllow(scope: FastifyInstance, deps: ConsolePlayerDeps): void {
  scope.get("/name-allow", read, async (request, reply) => {
    const query = parse(allowQuery, request.query);
    const who = await throttled(deps, request, reply, CONSOLE_WORDS_READ_LIMIT);
    return readAllowWords(deps.pool, who, {
      q: query.q ?? null,
      language: query.language ?? null,
      after: query.after ?? null,
    });
  });

  scope.post("/name-allow", change, async (request, reply) => {
    const { word } = parse(allowBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_WORDS_WRITE_LIMIT);
    await addAllowWord(deps.pool, who, word, request.id);
    return reply.code(201).send({ word });
  });

  scope.delete("/name-allow/:word", change, async (request, reply) => {
    const { word } = parse(wordParams, request.params);
    const who = await throttled(deps, request, reply, CONSOLE_WORDS_WRITE_LIMIT);
    await removeAllowWord(deps.pool, who, word, request.id);
    return reply.code(204).send();
  });
}

/**
 * The console's safety tools (T-705): ban and lift on a player's record (FR-1416), and the username word lists and
 * retired names, and the full-name allow-list (FR-1779). Registered inside the console scope, whose hook answers 404 to anyone but an active
 * platform admin; every door re-reads the admin in the database and writes the audit entry.
 */
export function registerConsoleSafetyRoutes(scope: FastifyInstance, deps: ConsolePlayerDeps): void {
  registerStanding(scope, deps);
  registerWords(scope, deps);
  registerNameAllow(scope, deps);
}
