import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { hiddenNotFound, notFound } from "#src/auth/http-errors";
import type { PublicAccount } from "#src/auth/staff-store";
import { HttpError } from "./http-error";
import { MemoryIdempotencyStore, type IdempotencyStore } from "./idempotency-store";
import { loggableError, registerConventions } from "./conventions";

const DAY_MS = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let clock = 1_000_000;
let calls = 0;
let slow: {
  entered: () => void;
  started: Promise<void>;
  finish: () => void;
  finished: Promise<void>;
};

/** Lets a test hold the /slow route open until it says so, instead of guessing with timers. */
function makeSlowGate(): typeof slow {
  const gate = {} as typeof slow;
  gate.started = new Promise<void>((resolve) => {
    gate.entered = resolve;
  });
  gate.finished = new Promise<void>((resolve) => {
    gate.finish = resolve;
  });
  return gate;
}

async function build(minAppVersion = "1.2.0"): Promise<FastifyInstance> {
  calls = 0;
  slow = makeSlowGate();
  const instance = Fastify({ genReqId: () => randomUUID() });
  const store = new MemoryIdempotencyStore(() => clock);
  registerConventions(instance, { minAppVersion, idempotencyStore: store });
  // Stands in for the staff scope, which sets the signed-in user as the owner of idempotency keys.
  instance.addHook("onRequest", async (request) => {
    const user = request.headers["x-test-user"];
    if (typeof user === "string") {
      request.principalId = user;
    }
  });

  instance.post("/pay", { config: { idempotent: true } }, async (request) => {
    calls += 1;
    return { received: request.body, call: calls };
  });
  instance.post("/things/:id", { config: { idempotent: true } }, async (request) => {
    calls += 1;
    return { id: (request.params as { id: string }).id, call: calls };
  });
  instance.post("/slow", { config: { idempotent: true } }, async () => {
    slow.entered();
    await slow.finished;
    calls += 1;
    return { done: true };
  });
  instance.post("/flaky", { config: { idempotent: true } }, async (_request, reply) => {
    calls += 1;
    if (calls === 1) {
      throw new Error("database exploded: password=hunter2");
    }
    return reply.send({ ok: true });
  });
  instance.post("/empty", { config: { idempotent: true } }, async (_request, reply) => {
    calls += 1;
    return reply.code(204).send();
  });
  instance.post("/created", { config: { idempotent: true } }, async (_request, reply) =>
    reply.code(201).header("content-type", "text/plain").send("made"),
  );
  instance.get("/lock-timeout", async () => {
    throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
  });
  instance.get("/statement-timeout", async () => {
    throw Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
  });
  instance.get("/too-many-connections", async () => {
    throw Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
  });
  instance.get("/deadlock", async () => {
    throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
  });
  instance.get("/serialization", async () => {
    throw Object.assign(new Error("could not serialize access"), { code: "40001" });
  });
  instance.get("/other-db-error", async () => {
    throw Object.assign(new Error("duplicate key"), { code: "23505" });
  });
  instance.get("/client-400", async () => {
    throw Object.assign(new Error("bad"), { statusCode: 400 });
  });
  instance.get("/client-499", async () => {
    throw Object.assign(new Error("odd"), { statusCode: 499 });
  });
  instance.get("/server-500", async () => {
    throw Object.assign(new Error("secret detail"), { statusCode: 500 });
  });
  instance.get("/forbidden", async () => {
    throw Object.assign(new Error("nope"), { statusCode: 403 });
  });
  instance.get("/gateway", async () => {
    throw Object.assign(new Error("upstream"), { statusCode: 502 });
  });
  instance.get("/teapot", async () => {
    throw new HttpError(
      418,
      "short_and_stout",
      { ar: "إبريق شاي", en: "I am a teapot" },
      { size: 1 },
    );
  });
  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app.close();
  clock = 1_000_000;
});

const post = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

describe("error envelope", () => {
  it("answers an unknown route with the standard envelope", async () => {
    app = await build();
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not_found", details: {} });
    expect(response.json().message).toEqual({ ar: expect.any(String), en: expect.any(String) });
  });

  it("returns an HttpError as thrown", async () => {
    app = await build();
    const response = await app.inject({ method: "GET", url: "/teapot" });
    expect(response.statusCode).toBe(418);
    expect(response.json()).toEqual({
      code: "short_and_stout",
      message: { ar: "إبريق شاي", en: "I am a teapot" },
      details: { size: 1 },
    });
  });

  it("hides the cause of an unexpected failure", async () => {
    app = await build();
    const response = await post("/flaky", { "idempotency-key": "k1" }, {});
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe("internal_error");
    expect(response.body).not.toContain("hunter2");
  });

  it("puts a request id on every response", async () => {
    app = await build();
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("app version", () => {
  it("asks an old app to update", async () => {
    app = await build("1.2.0");
    const response = await app.inject({
      method: "GET",
      url: "/teapot",
      headers: { "x-app-version": "1.1.9" },
    });
    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({
      code: "update_required",
      details: { minimumVersion: "1.2.0" },
    });
  });

  it.each(["1.2.0", "2.0.0"])("lets version %s through", async (version) => {
    app = await build("1.2.0");
    const response = await app.inject({
      method: "GET",
      url: "/teapot",
      headers: { "x-app-version": version },
    });
    expect(response.statusCode).toBe(418);
  });

  it("lets a caller with no version header through (the web)", async () => {
    app = await build("1.2.0");
    expect((await app.inject({ method: "GET", url: "/teapot" })).statusCode).toBe(418);
  });

  it("rejects a version that is not a version", async () => {
    app = await build();
    const response = await app.inject({
      method: "GET",
      url: "/teapot",
      headers: { "x-app-version": "banana" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_app_version");
  });
});

const as = (user: string) =>
  post("/pay", { "idempotency-key": "same", "x-test-user": user }, { amount: 1 });

describe("idempotency key", () => {
  it("is required on an unsafe route", async () => {
    app = await build();
    const response = await post("/pay", {}, { amount: 1 });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("idempotency_key_required");
    expect(calls).toBe(0);
  });

  it("runs the action once and replays the first answer", async () => {
    app = await build();
    const first = await post("/pay", { "idempotency-key": "abc" }, { amount: 1 });
    const second = await post("/pay", { "idempotency-key": "abc" }, { amount: 1 });
    expect(calls).toBe(1);
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("keeps keys apart per signed-in user, so two users can reuse the same key", async () => {
    app = await build();
    const [first, second, firstAgain] = [
      await as("user-a"),
      await as("user-b"),
      await as("user-a"),
    ];
    expect(calls).toBe(2);
    expect(first.json().call).toBe(1);
    expect(second.json().call).toBe(2);
    expect(firstAgain.json().call).toBe(1);
    expect(firstAgain.headers["idempotent-replayed"]).toBe("true");
  });

  it("remembers an empty 204 answer, so a retry replays it instead of running the action again", async () => {
    app = await build();
    const first = await post("/empty", { "idempotency-key": "e" }, {});
    const second = await post("/empty", { "idempotency-key": "e" }, {});
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("refuses the same key on another path of the same route, never replaying the first path's answer", async () => {
    app = await build();
    const first = await post("/things/a", { "idempotency-key": "k" }, { code: "X" });
    const other = await post("/things/b", { "idempotency-key": "k" }, { code: "X" });
    const again = await post("/things/a?ignored=1", { "idempotency-key": "k" }, { code: "X" });
    expect(first.json()).toEqual({ id: "a", call: 1 });
    expect(other.statusCode).toBe(422);
    expect(other.json().code).toBe("idempotency_key_reused");
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("refuses the same key with a different body", async () => {
    app = await build();
    await post("/pay", { "idempotency-key": "abc" }, { amount: 1 });
    const other = await post("/pay", { "idempotency-key": "abc" }, { amount: 2 });
    expect(other.statusCode).toBe(422);
    expect(other.json().code).toBe("idempotency_key_reused");
    expect(calls).toBe(1);
  });

  it("refuses a second request while the first is still running", async () => {
    app = await build();
    const running = post("/slow", { "idempotency-key": "s" }, {});
    await slow.started;
    const duplicate = await post("/slow", { "idempotency-key": "s" }, {});
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("request_in_progress");
    slow.finish();
    expect((await running).statusCode).toBe(200);
    expect(calls).toBe(1);
  });

  it("lets the caller retry after a server error", async () => {
    app = await build();
    const failed = await post("/flaky", { "idempotency-key": "f" }, {});
    expect(failed.statusCode).toBe(500);
    const retried = await post("/flaky", { "idempotency-key": "f" }, {});
    expect(retried.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("forgets a key after 24 hours", async () => {
    app = await build();
    await post("/pay", { "idempotency-key": "old" }, { amount: 1 });
    clock += DAY_MS + 1;
    await post("/pay", { "idempotency-key": "old" }, { amount: 1 });
    expect(calls).toBe(2);
  });

  it.each([
    "",
    "x".repeat(256),
    "has space",
    "tab\there",
    "sub:12",
    "quiz:12",
    "pass:1",
    "meet:1",
    "game:1",
    "practice:1",
  ])("rejects the key %j", async (key) => {
    app = await build();
    const response = await post("/pay", { "idempotency-key": key }, {});
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("idempotency_key_invalid");
  });
});

const BILINGUAL = { ar: expect.stringMatching(/\S/), en: expect.stringMatching(/\S/) };

describe("every error speaks both languages", () => {
  it.each([
    ["/nope", {}],
    ["/teapot", { "x-app-version": "banana" }],
    ["/teapot", { "x-app-version": "0.1.0" }],
    ["/forbidden", {}],
    ["/gateway", {}],
  ])("%s %j", async (url, headers) => {
    app = await build();
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.json().message).toEqual(BILINGUAL);
    expect(response.json().details).toBeDefined();
  });

  it.each([
    [{}, "idempotency_key_required"],
    [{ "idempotency-key": "bad key" }, "idempotency_key_invalid"],
  ])("idempotency headers %j", async (headers, code) => {
    app = await build();
    const response = await post("/pay", headers, {});
    expect(response.json().code).toBe(code);
    expect(response.json().message).toEqual(BILINGUAL);
  });

  it("reused key and in-progress answers too", async () => {
    app = await build();
    await post("/pay", { "idempotency-key": "r" }, { a: 1 });
    expect((await post("/pay", { "idempotency-key": "r" }, { a: 2 })).json().message).toEqual(
      BILINGUAL,
    );
    const running = post("/slow", { "idempotency-key": "p" }, {});
    await slow.started;
    expect((await post("/slow", { "idempotency-key": "p" }, {})).json().message).toEqual(BILINGUAL);
    slow.finish();
    await running;
  });
});

describe("other failures", () => {
  it("keeps the status of a client error from the framework", async () => {
    app = await build();
    const response = await app.inject({ method: "GET", url: "/forbidden" });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("invalid_request");
  });

  it("treats a 5xx from a dependency as an internal error", async () => {
    app = await build();
    const response = await app.inject({ method: "GET", url: "/gateway" });
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe("internal_error");
  });

  it("answers a body that is not valid JSON with the envelope", async () => {
    app = await build();
    const response = await app.inject({
      method: "POST",
      url: "/pay",
      headers: { "idempotency-key": "j", "content-type": "application/json" },
      payload: "{broken",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_request");
  });

  it("replays the status and content type of the first answer", async () => {
    app = await build();
    const first = await post("/created", { "idempotency-key": "c" }, {});
    const second = await post("/created", { "idempotency-key": "c" }, {});
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe("made");
    expect(second.headers["content-type"]).toContain("text/plain");
  });

  it("keeps a key valid until 24 hours have passed", async () => {
    app = await build();
    await post("/pay", { "idempotency-key": "edge" }, { a: 1 });
    clock += DAY_MS - 1;
    await post("/pay", { "idempotency-key": "edge" }, { a: 1 });
    expect(calls).toBe(1);
    clock += 1;
    await post("/pay", { "idempotency-key": "edge" }, { a: 1 });
    expect(calls).toBe(2);
  });

  it("scopes a key to the caller and the route", async () => {
    app = await build();
    await post("/pay", { "idempotency-key": "same" }, {});
    await post("/created", { "idempotency-key": "same" }, {});
    expect(calls).toBe(1);
    const mismatch = await post("/created", { "idempotency-key": "same" }, { other: true });
    expect(mismatch.statusCode).toBe(422);
  });
});

describe("HttpError", () => {
  it("carries its status and a readable message", () => {
    const error = new HttpError(409, "clash", { ar: "تعارض", en: "Clash" });
    expect(error.status).toBe(409);
    expect(error.message).toBe("clash: Clash");
    expect(error.envelope.details).toEqual({});
  });
});

describe("a busy database", () => {
  it.each([
    "/lock-timeout",
    "/statement-timeout",
    "/too-many-connections",
    "/deadlock",
    "/serialization",
  ])("answers %s with 503 busy and a Retry-After, not an internal error", async (url) => {
    app = await build();
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toMatchObject({ code: "busy" });
  });

  it("still treats any other database error as an internal error without leaking it", async () => {
    app = await build();
    const response = await app.inject({ method: "GET", url: "/other-db-error" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("duplicate key");
  });
});

describe("the error log", () => {
  it("keeps a database error's code and names but never its DETAIL or WHERE", () => {
    const error = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint: "word_guess_list_pkey",
      detail: "Key (language, word)=(en, hunter) already exists.",
      where: "PL/pgSQL function word_list_change(text,text[],text[],uuid) line 20",
    });
    const kept = loggableError(error);
    expect(kept).toMatchObject({
      type: "Error",
      code: "23505",
      constraint: "word_guess_list_pkey",
    });
    expect(kept).not.toHaveProperty("detail");
    expect(kept).not.toHaveProperty("where");
    expect(JSON.stringify(kept)).not.toContain("hunter");
  });

  it("does not log the value a 22P02 data exception echoes, in the message or the stack", async () => {
    const sentinel = "SENTINEL-7f3a9c-player-input";
    const lines: string[] = [];
    const logged = Fastify({
      logger: { stream: { write: (line: string) => void lines.push(line) } },
    });
    registerConventions(logged, {
      minAppVersion: "1.2.0",
      idempotencyStore: new MemoryIdempotencyStore(),
    });
    logged.get("/bad-uuid", async () => {
      throw Object.assign(new Error(`invalid input syntax for type uuid: "${sentinel}"`), {
        code: "22P02",
        routine: "string_to_uuid",
        where: `unnamed portal parameter $1 = '${sentinel}'`,
      });
    });
    app = logged;
    const response = await logged.inject({ method: "GET", url: "/bad-uuid" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(sentinel);
    const text = lines.join("");
    expect(text).toContain("22P02");
    expect(text).not.toContain(sentinel);
    // Other errors keep their message: it names the constraint, not a value.
    const kept = loggableError(
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    );
    expect(kept).toMatchObject({ message: "duplicate key value violates unique constraint" });
  });

  it("keeps the text of a data exception that echoes nothing, such as 22001", () => {
    const error = Object.assign(new Error("value too long for type character varying(10)"), {
      code: "22001",
    });
    const kept = loggableError(error);
    expect(kept["message"]).toBe("value too long for type character varying(10)");
    expect(String(kept["stack"])).toContain("value too long for type character varying(10)");
    const quoted = loggableError(
      Object.assign(new Error(`invalid input value for enum kind: 'secret' and "other"`), {
        code: "22P02",
      }),
    );
    expect(quoted["message"]).toBe('invalid input value for enum kind: "…" and "…"');
    expect(JSON.stringify(quoted)).not.toContain("secret");
  });

  it("logs an unexpected error without the player's input", async () => {
    const lines: string[] = [];
    const logged = Fastify({
      logger: { stream: { write: (line: string) => void lines.push(line) } },
    });
    registerConventions(logged, {
      minAppVersion: "1.2.0",
      idempotencyStore: new MemoryIdempotencyStore(),
    });
    logged.get("/boom", async () => {
      throw Object.assign(new Error("new row violates check constraint"), {
        code: "23514",
        detail: "Failing row contains (secret-guess).",
        where: "SQL statement INSERT INTO daily_guess VALUES (secret-guess)",
      });
    });
    app = logged;
    const response = await logged.inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(500);
    const text = lines.join("");
    expect(text).toContain("23514");
    expect(text).not.toContain("secret-guess");
  });
});

describe("error edges", () => {
  it.each([
    ["/client-400", 400],
    ["/client-499", 499],
  ])("keeps a framework client error %s as %i with the generic message", async (url, status) => {
    app = await build();
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
  });

  it("treats a framework error marked 500 as an internal error, without its detail", async () => {
    app = await build();
    const response = await app.inject({ method: "GET", url: "/server-500" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "internal_error" });
    expect(response.body).not.toContain("secret detail");
  });

  it("says the database is busy in both languages", async () => {
    app = await build();
    const response = await app.inject({ method: "GET", url: "/lock-timeout" });
    expect(response.json()).toEqual({
      code: "busy",
      message: {
        ar: "الخدمة مشغولة. حاول بعد لحظات.",
        en: "The service is busy. Try again in a moment.",
      },
      details: {},
    });
  });
});

const expectHeaders = (response: { headers: Record<string, unknown> }, label: string) => {
  expect(response.headers["strict-transport-security"], label).toBe(
    "max-age=31536000; includeSubDomains",
  );
  expect(response.headers["x-content-type-options"], label).toBe("nosniff");
  expect(response.headers["content-security-policy"], label).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
};

describe("security headers (ADR-700)", () => {
  it.each([
    ["a handler's answer", "POST", "/pay", { "idempotency-key": "k-1" }, 200],
    ["a refusal it throws", "GET", "/teapot", {}, 418],
    ["a framework client error", "GET", "/client-400", {}, 400],
    ["the not-found handler", "GET", "/nowhere", {}, 404],
    ["an old app's 426 from onRequest", "GET", "/teapot", { "x-app-version": "1.0.0" }, 426],
    ["an internal error", "GET", "/server-500", {}, 500],
  ] as const)("are on %s", async (label, method, url, headers, status) => {
    app = await build();
    const response = await app.inject({ method, url, headers, payload: { a: 1 } });
    expect(response.statusCode, label).toBe(status);
    expectHeaders(response, label);
  });

  it("are on an idempotent replay", async () => {
    app = await build();
    await post("/pay", { "idempotency-key": "replay-1" }, { a: 1 });
    const replay = await post("/pay", { "idempotency-key": "replay-1" }, { a: 1 });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expectHeaders(replay, "replay");
  });

  it("are on a body Fastify refuses as too large (413) or of an unknown type (415)", async () => {
    app = await build();
    const tooLarge = await app.inject({
      method: "POST",
      url: "/pay",
      headers: { "idempotency-key": "big-1", "content-type": "application/json" },
      payload: JSON.stringify({ a: "x".repeat(1_100_000) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expectHeaders(tooLarge, "413");
    const unknownType = await app.inject({
      method: "POST",
      url: "/pay",
      headers: { "idempotency-key": "type-1", "content-type": "application/xml" },
      payload: "<a/>",
    });
    expect(unknownType.statusCode).toBe(415);
    expectHeaders(unknownType, "415");
  });

  it("stay on the answer when the idempotency store fails inside its own onSend", async () => {
    const failing: IdempotencyStore = {
      begin: async () => ({ kind: "new" }),
      finish: async () => {
        throw new Error("store down");
      },
      abort: async () => undefined,
      forget: async () => undefined,
    };
    app = Fastify();
    registerConventions(app, { minAppVersion: "1.0.0", idempotencyStore: failing });
    app.post("/pay", { config: { idempotent: true } }, async () => ({ ok: true }));
    await app.ready();
    const response = await post("/pay", { "idempotency-key": "fail-1" }, { a: 1 });
    expect(response.statusCode).toBe(500);
    expectHeaders(response, "store failure");
  });
});

describe("the authz.denied line (ADR-703)", () => {
  let lines: Record<string, unknown>[] = [];

  async function buildLogged(): Promise<FastifyInstance> {
    lines = [];
    const instance = Fastify({
      logger: {
        level: "warn",
        stream: { write: (line: string) => void lines.push(JSON.parse(line)) },
      },
    });
    registerConventions(instance, {
      minAppVersion: "1.0.0",
      idempotencyStore: new MemoryIdempotencyStore(),
    });
    instance.addHook("onRequest", async (request) => {
      const kind = request.headers["x-test-kind"];
      const id = "6f1c2d3e-0000-4000-8000-000000000001";
      if (kind === "staff") {
        request.staff = {
          account: { id } as PublicAccount,
          sessionId: "s-1",
          tokenHash: "",
          surface: "dashboard",
        };
      } else if (kind === "player") {
        request.player = { id };
      }
    });
    instance.get("/things/:thingId/forbidden", async () => {
      throw new HttpError(403, "owner_only", { ar: "للمالك فقط.", en: "Owner only." });
    });
    instance.get("/things/:thingId/hidden", async () => {
      throw hiddenNotFound();
    });
    instance.get("/things/:thingId/absent", async () => {
      throw notFound();
    });
    await instance.ready();
    return instance;
  }

  const denials = () => lines.filter((line) => line["event"] === "authz.denied");

  it("logs a 403 and a hidden 404 once each, and a plain 404 not at all", async () => {
    app = await buildLogged();
    const headers = { "x-test-kind": "staff" };
    const forbidden = await app.inject({ url: "/things/42/forbidden?secret=1", headers });
    const hidden = await app.inject({ url: "/things/42/hidden", headers });
    const absent = await app.inject({ url: "/things/42/absent", headers });
    expect([forbidden.statusCode, hidden.statusCode, absent.statusCode]).toEqual([403, 404, 404]);
    expect(hidden.json()).toEqual(absent.json());
    expect(denials()).toHaveLength(2);
  });

  it("holds exactly the route pattern, the status and code, and who: never the filled path or query", async () => {
    app = await buildLogged();
    await app.inject({
      url: "/things/42/hidden?phone=0500000000",
      headers: { "x-test-kind": "staff" },
    });
    const [line] = denials();
    const { level: _level, time: _time, pid: _pid, hostname: _host, reqId, ...rest } = line ?? {};
    expect(typeof reqId).toBe("string");
    expect(rest).toEqual({
      event: "authz.denied",
      method: "GET",
      route: "/things/:thingId/hidden",
      status: 404,
      code: "not_found",
      actorKind: "staff",
      actorId: "6f1c2d3e-0000-4000-8000-000000000001",
    });
    expect(JSON.stringify(lines)).not.toContain("0500000000");
    expect(JSON.stringify(denials())).not.toContain("/things/42");
  });

  it.each([
    ["player", "player", "6f1c2d3e-0000-4000-8000-000000000001"],
    ["nobody", "anonymous", null],
  ])("names a %s by what the guard set", async (kind, actorKind, actorId) => {
    app = await buildLogged();
    await app.inject({ url: "/things/1/forbidden", headers: { "x-test-kind": kind } });
    expect(denials()[0]).toMatchObject({ actorKind, actorId });
  });
});
