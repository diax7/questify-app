import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { forward, type ForwardOptions } from "#src/lib/forward.ts";
import {
  appHeaders,
  authStepOf,
  clearedPlayerCookie,
  isOperatorPath,
  issuedPairOf,
  playerCookie,
  readPlayerCookie,
  setsPlayerCookie,
  takesBearer,
} from "#src/lib/player-session.ts";
import { startUpstream, type Seen, type Upstream } from "#src/lib/upstream.test-support.ts";

const WEB = "https://app.questify.test";
const token = () => randomBytes(32).toString("base64url");
const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";
const CLEARED = `__Host-qs_player=; ${ATTRIBUTES}; Max-Age=0`;
const PLAYER = { id: "p-1", username: "noura" };

type Reply = (request: Seen, response: ServerResponse) => void;
const json =
  (status: number, body: unknown, extra: Record<string, string | string[]> = {}): Reply =>
  (_request, response) => {
    for (const [name, value] of Object.entries(extra)) {
      response.setHeader(name, value);
    }
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

const appHeadersOf = (deviceId: string, appVersion: string) =>
  appHeaders(new Headers({ "x-device-id": deviceId, "x-app-version": appVersion }));

describe("the cookie helpers", () => {
  const access = token();
  const refresh = token();

  it("reads exactly one well-formed cookie and keeps every other cookie", () => {
    expect(
      readPlayerCookie(`__Host-qs_session=s1; __Host-qs_player=${access}.${refresh}; qs_device=d`),
    ).toEqual({
      pair: { access, refresh },
      present: true,
      duplicate: false,
      others: "__Host-qs_session=s1; qs_device=d",
    });
    expect(readPlayerCookie(null)).toEqual({
      pair: undefined,
      present: false,
      duplicate: false,
      others: undefined,
    });
  });

  it.each([
    `${access}`,
    `${access}.`,
    `${access}.${refresh}.${access}`,
    `${access.slice(1)}.${refresh}`,
    `${access}.${refresh}x`,
    `${access}.${refresh.slice(0, 42)}=`,
    "",
  ])("counts a value not shaped like two tokens as no cookie (%s)", (value) => {
    const read = readPlayerCookie(`__Host-qs_player=${value}`);
    expect(read.pair).toBeUndefined();
    expect(read.present).toBe(true);
  });

  it("counts a cookie sent twice as no cookie, and strips every instance", () => {
    const read = readPlayerCookie(
      `__Host-qs_player=${access}.${refresh}; a=1; __Host-qs_player=${access}.${refresh}`,
    );
    expect(read).toEqual({ pair: undefined, present: true, duplicate: true, others: "a=1" });
  });

  it("writes the exact cookie and its clearing", () => {
    expect(playerCookie({ access, refresh })).toBe(
      `__Host-qs_player=${access}.${refresh}; ${ATTRIBUTES}; Max-Age=15552000`,
    );
    expect(clearedPlayerCookie()).toBe(CLEARED);
  });

  it("knows an upstream set-cookie of its own name, whatever the case", () => {
    expect(setsPlayerCookie("__Host-qs_player=x; Path=/")).toBe(true);
    expect(setsPlayerCookie(" __host-QS_player=x")).toBe(true);
    expect(setsPlayerCookie("__Host-qs_session=x; Path=/")).toBe(false);
  });

  it("finds a pair only when both tokens have the API's shape", () => {
    expect(issuedPairOf({ accessToken: access, refreshToken: refresh })).toEqual({
      access,
      refresh,
    });
    expect(issuedPairOf({ accessToken: access })).toBeUndefined();
    expect(issuedPairOf({ accessToken: "short", refreshToken: refresh })).toBeUndefined();
    expect(issuedPairOf(null)).toBeUndefined();
    expect(issuedPairOf("text")).toBeUndefined();
  });

  it("names the steps, the operator paths and where a bearer goes", () => {
    expect(authStepOf("POST", "/v1/auth/verify")).toBe("sign_in");
    expect(authStepOf("POST", "/v1/auth/signup")).toBe("sign_in");
    expect(authStepOf("POST", "/v1/auth/refresh")).toBe("refresh");
    expect(authStepOf("POST", "/v1/auth/logout")).toBe("logout");
    expect(authStepOf("GET", "/v1/auth/refresh")).toBeUndefined();
    expect(authStepOf("POST", "/v1/auth/code")).toBeUndefined();
    expect(isOperatorPath("/v1/operator/events")).toBe(true);
    expect(isOperatorPath("/v1/me/operator-events")).toBe(true);
    expect(isOperatorPath("/v1/me/operator-events/x")).toBe(true);
    expect(isOperatorPath("/v1/operator-invites/claim")).toBe(true);
    expect(isOperatorPath("/v1/operator-invites/preview")).toBe(true);
    expect(isOperatorPath("/v1/events/0b9f6f3e/operator/play")).toBe(true);
    expect(isOperatorPath("/v1/events/0b9f6f3e/play")).toBe(false);
    expect(isOperatorPath("/v1/events/a/b/operator/play")).toBe(false);
    expect(isOperatorPath("/v1/operators")).toBe(false);
    expect(isOperatorPath("/v1/me")).toBe(false);
    for (const path of [
      "/v1/auth/code",
      "/v1/staff/me",
      "/v1/admin/players",
      "/v1/device/pair",
      "/v1/device",
      "/v1/organizers/me",
      "/v1/operator/events",
      "/v1/me/operator-events",
    ]) {
      expect(takesBearer(path), path).toBe(false);
    }
    for (const path of ["/v1/me", "/v1/me/devices", "/v1/events/e/home", "/v1/devices"]) {
      expect(takesBearer(path), path).toBe(true);
    }
  });

  it("keeps x-device-id only as a UUID and x-app-version only as a version", () => {
    expect(appHeadersOf("0b9f6f3e-8d4c-4a51-9a51-1c2d3e4f5a6b", "1.2.3")).toEqual({
      "x-device-id": "0b9f6f3e-8d4c-4a51-9a51-1c2d3e4f5a6b",
      "x-app-version": "1.2.3",
    });
    expect(appHeadersOf("not-a-uuid", "1.2.3.4")).toEqual({});
    expect(appHeadersOf("0b9f6f3e-8d4c-4a51-9a51-1c2d3e4f5a6bX", "1.2-beta")).toEqual({});
    expect(appHeadersOf("x", "7")).toEqual({ "x-app-version": "7" });
    expect(appHeaders(new Headers())).toEqual({});
  });
});

describe("the forwarder's player web session (PLAYER_WEB_SESSION on)", () => {
  let api: Upstream;
  let logged: Readonly<Record<string, string>>[] = [];
  const options = (extra: Partial<ForwardOptions> = {}): ForwardOptions => ({
    apiOrigin: api.origin,
    timeoutMs: 2_000,
    maxBodyBytes: 4_096,
    log: (fields) => logged.push(fields),
    webOrigin: WEB,
    playerSession: true,
    refuseConsoleApi: false,
    ...extra,
  });
  const old = { access: token(), refresh: token() };
  const oldCookie = `__Host-qs_player=${old.access}.${old.refresh}`;
  const issued = { accessToken: token(), refreshToken: token(), expiresInSeconds: 3600 };
  const newCookie = `__Host-qs_player=${issued.accessToken}.${issued.refreshToken}; ${ATTRIBUTES}; Max-Age=15552000`;

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    forward(
      new Request(`${WEB}${path}`, {
        method: "POST",
        headers: { origin: WEB, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      options(),
    );
  const verifyBody = { challengeToken: token(), code: "123456" };
  const get = (path: string, headers: Record<string, string>) =>
    forward(new Request(`${WEB}${path}`, { headers }), options());
  const write = (
    path: string,
    headers: Record<string, string>,
    method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
  ) =>
    forward(new Request(`${WEB}${path}`, { method, headers, body: JSON.stringify({}) }), options());

  beforeAll(async () => {
    api = await startUpstream();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(() => {
    api.seen.length = 0;
    logged = [];
    api.answer(json(200, { ...issued, player: PLAYER }));
  });

  describe("step 1: verify and signup", () => {
    it("sets the exact cookie on verify, keeps every token out of the body, and sends the device as web", async () => {
      const response = await post("/v1/auth/verify", {
        ...verifyBody,
        device: { platform: "ios", model: "iPhone 15", userAgent: "x" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([newCookie]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const raw = await response.text();
      expect(raw).not.toContain(issued.accessToken);
      expect(raw).not.toContain(issued.refreshToken);
      expect(JSON.parse(raw)).toEqual({ signedIn: true, expiresInSeconds: 3600, player: PLAYER });
      expect(api.seen.map((seen) => seen.url)).toEqual(["/v1/auth/verify"]);
      expect(JSON.parse(api.seen[0]?.body ?? "")).toEqual({
        ...verifyBody,
        device: { platform: "web" },
      });
    });

    it("sets the cookie on signup's 201 with the same body", async () => {
      api.answer(json(201, { ...issued, player: PLAYER }));
      const response = await post("/v1/auth/signup", { signupToken: token(), username: "n" });
      expect(response.status).toBe(201);
      expect(response.headers.getSetCookie()).toEqual([newCookie]);
      expect(await response.json()).toEqual({
        signedIn: true,
        expiresInSeconds: 3600,
        player: PLAYER,
      });
      expect(JSON.parse(api.seen[0]?.body ?? "").device).toEqual({ platform: "web" });
    });

    it("passes the new-player step through with no cookie", async () => {
      const signupToken = token();
      api.answer(json(200, { isNew: true, signupToken }));
      const response = await post("/v1/auth/verify", verifyBody);
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.json()).toEqual({ isNew: true, signupToken });
    });

    it("passes an error through with its status, body and Retry-After, and no cookie", async () => {
      api.answer(
        json(
          429,
          { code: "too_many_attempts", message: { ar: "ك", en: "w" }, details: {} },
          {
            "retry-after": "60",
          },
        ),
      );
      const response = await post("/v1/auth/verify", verifyBody);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(((await response.json()) as { code: string }).code).toBe("too_many_attempts");
      api.answer(json(422, { code: "invalid_code", message: { ar: "ر", en: "c" }, details: {} }));
      const wrong = await post("/v1/auth/verify", verifyBody);
      expect([wrong.status, wrong.headers.getSetCookie()]).toEqual([422, []]);
    });

    it("answers 502 to a 2xx without tokens, and never a signup token on signup", async () => {
      api.answer(json(200, { accessToken: "short", refreshToken: token() }));
      expect((await post("/v1/auth/verify", verifyBody)).status).toBe(502);
      api.answer(json(201, { isNew: true, signupToken: token() }));
      const response = await post("/v1/auth/signup", { signupToken: token() });
      expect([response.status, response.headers.getSetCookie()]).toEqual([502, []]);
      api.answer(json(200, { signupToken: token(), refreshToken: token() }));
      expect((await post("/v1/auth/verify", verifyBody)).status).toBe(502);
    });

    it("logs out the cookie the browser still holds before it signs in, with the person's address", async () => {
      const order: string[] = [];
      api.answer((request, response) => {
        order.push(request.url);
        if (request.url === "/v1/auth/logout") {
          response.writeHead(204).end();
          return;
        }
        json(200, { ...issued, player: PLAYER })(request, response);
      });
      const response = await post("/v1/auth/verify", verifyBody, {
        cookie: `${oldCookie}; __Host-qs_session=s1`,
        "x-forwarded-for": "203.0.113.9",
        "user-agent": "Browser/1",
      });
      expect(order).toEqual(["/v1/auth/logout", "/v1/auth/verify"]);
      expect(JSON.parse(api.seen[0]?.body ?? "")).toEqual({ refreshToken: old.refresh });
      for (const seen of api.seen) {
        expect(seen.headers["x-forwarded-for"]).toBe("203.0.113.9");
        expect(seen.headers["user-agent"]).toBe("Browser/1");
        expect(seen.headers["cookie"]).toBe("__Host-qs_session=s1");
        expect(seen.headers["authorization"]).toBeUndefined();
      }
      expect(response.headers.getSetCookie()).toEqual([newCookie]);
    });

    it("signs in even when the logout first fails, and logs only the method, path and reason", async () => {
      api.answer((request, response) => {
        if (request.url === "/v1/auth/logout") {
          response.writeHead(503).end();
          return;
        }
        json(422, { code: "invalid_code", message: { ar: "ر", en: "c" }, details: {} })(
          request,
          response,
        );
      });
      const response = await post("/v1/auth/verify", verifyBody, { cookie: oldCookie });
      expect(response.status).toBe(422);
      // The logout failed, so the cookie may still be live: it stays for the next try.
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(logged).toEqual([
        {
          event: "api_forward_failed",
          method: "POST",
          path: "/v1/auth/logout",
          reason: "status_503",
        },
      ]);
    });

    it("clears the old cookie when a sign-in after its logout is refused", async () => {
      api.answer((request, response) => {
        if (request.url === "/v1/auth/logout") {
          response.writeHead(204).end();
          return;
        }
        json(422, { code: "invalid_code", message: { ar: "ر", en: "c" }, details: {} })(
          request,
          response,
        );
      });
      const response = await post("/v1/auth/verify", verifyBody, { cookie: oldCookie });
      expect([response.status, response.headers.getSetCookie()]).toEqual([422, [CLEARED]]);
    });

    it("refuses a body over 2 KiB, or one that is not a JSON object, before calling the API", async () => {
      const big = await post("/v1/auth/verify", { ...verifyBody, pad: "x".repeat(2_048) });
      expect(big.status).toBe(413);
      for (const body of [[1, 2], "text", null]) {
        expect((await post("/v1/auth/verify", body)).status).toBe(400);
      }
      const notJson = await forward(
        new Request(`${WEB}/v1/auth/verify`, { method: "POST", headers: { origin: WEB } }),
        options(),
      );
      expect(notJson.status).toBe(400);
      expect(api.seen).toEqual([]);
    });

    it("answers 502 when the API cannot be reached, and logs no token", async () => {
      const response = await forward(
        new Request(`${WEB}/v1/auth/verify`, {
          method: "POST",
          headers: { origin: WEB, cookie: oldCookie },
          body: JSON.stringify(verifyBody),
        }),
        options({ apiOrigin: "http://127.0.0.1:9" }),
      );
      expect(response.status).toBe(502);
      expect(logged.map((line) => [line["path"], line["reason"]])).toEqual([
        ["/v1/auth/logout", "unreachable"],
        ["/v1/auth/verify", "unreachable"],
      ]);
      expect(JSON.stringify(logged)).not.toContain(old.refresh);
    });
  });

  describe("step 2: refresh", () => {
    it("answers 401 with no cookie, without calling the API", async () => {
      const response = await post("/v1/auth/refresh", { refreshToken: token() });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe("unauthenticated");
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(api.seen).toEqual([]);
    });

    it("sends the cookie's refresh token, never the browser's body, and sets the new cookie", async () => {
      const response = await post(
        "/v1/auth/refresh",
        { refreshToken: token() },
        {
          cookie: oldCookie,
          "x-forwarded-for": "203.0.113.9",
          "user-agent": "Browser/1",
        },
      );
      expect(response.status).toBe(200);
      expect(JSON.parse(api.seen[0]?.body ?? "")).toEqual({ refreshToken: old.refresh });
      expect(api.seen[0]?.headers["x-forwarded-for"]).toBe("203.0.113.9");
      expect(api.seen[0]?.headers["user-agent"]).toBe("Browser/1");
      expect(api.seen[0]?.headers["authorization"]).toBeUndefined();
      expect(api.seen[0]?.headers["cookie"]).toBeUndefined();
      expect(response.headers.getSetCookie()).toEqual([newCookie]);
      const raw = await response.text();
      expect(raw).not.toContain(issued.refreshToken);
      expect(JSON.parse(raw)).toEqual({ signedIn: true, expiresInSeconds: 3600, player: PLAYER });
    });

    it("never passes the browser's idempotency-key or if-none-match on its own calls", async () => {
      const browser = {
        cookie: oldCookie,
        "idempotency-key": "idem-1",
        "if-none-match": '"etag-1"',
      };
      await post("/v1/auth/refresh", undefined, browser);
      await post("/v1/auth/logout", undefined, browser);
      await post("/v1/auth/verify", verifyBody, browser);
      // refresh, logout, then verify's logout of the old cookie and the verify itself
      expect(api.seen.map((seen) => seen.url)).toEqual([
        "/v1/auth/refresh",
        "/v1/auth/logout",
        "/v1/auth/logout",
        "/v1/auth/verify",
      ]);
      for (const seen of api.seen) {
        expect(seen.headers["idempotency-key"], seen.url).toBeUndefined();
        expect(seen.headers["if-none-match"], seen.url).toBeUndefined();
      }
    });

    it("turns the API's 401 into session_expired and clears the cookie", async () => {
      api.answer(json(401, { code: "unauthenticated", message: { ar: "ي", en: "s" } }));
      const response = await post("/v1/auth/refresh", undefined, { cookie: oldCookie });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe("session_expired");
      expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    });

    it("leaves the cookie on a 5xx, a timeout or no answer", async () => {
      api.answer(json(503, { code: "unavailable", message: { ar: "غ", en: "u" }, details: {} }));
      const failed = await post("/v1/auth/refresh", undefined, { cookie: oldCookie });
      expect([failed.status, failed.headers.getSetCookie()]).toEqual([503, []]);
      api.answer(() => undefined);
      const late = await forward(
        new Request(`${WEB}/v1/auth/refresh`, {
          method: "POST",
          headers: { origin: WEB, cookie: oldCookie },
        }),
        options({ timeoutMs: 100 }),
      );
      expect([late.status, late.headers.getSetCookie()]).toEqual([502, []]);
      expect(logged).toEqual([
        {
          event: "api_forward_failed",
          method: "POST",
          path: "/v1/auth/refresh",
          reason: "timeout",
        },
      ]);
    });

    it("answers 502 to a 200 without a token pair", async () => {
      api.answer(json(200, { ok: true }));
      const response = await post("/v1/auth/refresh", undefined, { cookie: oldCookie });
      expect([response.status, response.headers.getSetCookie()]).toEqual([502, []]);
    });

    it("clears a cookie sent twice and calls nobody", async () => {
      const response = await post("/v1/auth/refresh", undefined, {
        cookie: `${oldCookie}; ${oldCookie}`,
      });
      expect([response.status, response.headers.getSetCookie()]).toEqual([401, [CLEARED]]);
      expect(api.seen).toEqual([]);
    });
  });

  describe("step 3: logout", () => {
    it("ends the family with the cookie's refresh token and answers 204 with a clear", async () => {
      api.answer((_request, response) => response.writeHead(204).end());
      const response = await post(
        "/v1/auth/logout",
        { refreshToken: token() },
        {
          cookie: oldCookie,
          "x-forwarded-for": "203.0.113.9",
          "user-agent": "Browser/1",
        },
      );
      expect(response.status).toBe(204);
      expect(response.headers.getSetCookie()).toEqual([CLEARED]);
      expect(JSON.parse(api.seen[0]?.body ?? "")).toEqual({ refreshToken: old.refresh });
      expect(api.seen[0]?.headers["x-forwarded-for"]).toBe("203.0.113.9");
      expect(api.seen[0]?.headers["user-agent"]).toBe("Browser/1");
    });

    it("answers 204 with a clear when the API fails, or with no cookie at all", async () => {
      api.answer((_request, response) => response.writeHead(500).end());
      const failed = await post("/v1/auth/logout", undefined, { cookie: oldCookie });
      expect([failed.status, failed.headers.getSetCookie()]).toEqual([204, [CLEARED]]);
      expect(logged).toEqual([
        {
          event: "api_forward_failed",
          method: "POST",
          path: "/v1/auth/logout",
          reason: "status_500",
        },
      ]);
      api.seen.length = 0;
      const none = await post("/v1/auth/logout");
      expect([none.status, none.headers.getSetCookie()]).toEqual([204, [CLEARED]]);
      expect(api.seen).toEqual([]);
      const unreachable = await forward(
        new Request(`${WEB}/v1/auth/logout`, {
          method: "POST",
          headers: { origin: WEB, cookie: oldCookie },
        }),
        options({ apiOrigin: "http://127.0.0.1:9" }),
      );
      expect([unreachable.status, unreachable.headers.getSetCookie()]).toEqual([204, [CLEARED]]);
    });
  });

  describe("step 4: every other path", () => {
    it("sends the cookie's access token as the bearer on player paths, and strips the cookie", async () => {
      await get("/v1/me", { cookie: `a=1; ${oldCookie}; __Host-qs_session=s1` });
      expect(api.seen[0]?.headers["authorization"]).toBe(`Bearer ${old.access}`);
      expect(api.seen[0]?.headers["cookie"]).toBe("a=1; __Host-qs_session=s1");
    });

    it("never sends a bearer to the sign-in steps, staff, admin, device or organizer paths", async () => {
      for (const path of [
        "/v1/auth/code",
        "/v1/staff/me",
        "/v1/admin/players",
        "/v1/device",
        "/v1/organizers/me",
      ]) {
        api.seen.length = 0;
        await forward(
          new Request(`${WEB}${path}`, {
            method: "POST",
            headers: { origin: WEB, cookie: oldCookie },
            body: "{}",
          }),
          options(),
        );
        expect(api.seen[0]?.headers["authorization"], path).toBeUndefined();
        expect(api.seen[0]?.headers["cookie"], path).toBeUndefined();
      }
    });

    it("never forwards a browser's own Authorization, with or without the cookie", async () => {
      await get("/v1/me", { authorization: "Bearer stolen" });
      expect(api.seen[0]?.headers["authorization"]).toBeUndefined();
      await get("/v1/me", { authorization: "Bearer stolen", cookie: oldCookie });
      expect(api.seen[1]?.headers["authorization"]).toBe(`Bearer ${old.access}`);
    });

    it("sends no bearer for a malformed cookie, and clears a duplicated one", async () => {
      const malformed = await get("/v1/me", { cookie: "__Host-qs_player=nope" });
      expect(api.seen[0]?.headers["authorization"]).toBeUndefined();
      expect(api.seen[0]?.headers["cookie"]).toBeUndefined();
      expect(malformed.headers.getSetCookie()).toEqual([]);
      const twice = await get("/v1/me", { cookie: `${oldCookie}; ${oldCookie}` });
      expect(api.seen[1]?.headers["authorization"]).toBeUndefined();
      expect(api.seen[1]?.headers["cookie"]).toBeUndefined();
      expect(twice.headers.getSetCookie()).toEqual([CLEARED]);
    });

    it("answers 404 to operator paths for a cookie request, without calling the API", async () => {
      for (const path of [
        "/v1/operator/events",
        "/v1/me/operator-events",
        "/v1/operator-invites/claim",
        "/v1/operator-invites/preview",
        "/v1/events/0b9f6f3e-8d4c-4a51-9a51-1c2d3e4f5a6b/operator/play",
      ]) {
        const response = await get(path, { cookie: oldCookie });
        expect(response.status, path).toBe(404);
      }
      expect(api.seen).toEqual([]);
      expect((await get("/v1/operator/events", {})).status).toBe(200);
    });

    it("forwards x-device-id and x-app-version only in their shapes", async () => {
      await get("/v1/me", {
        "x-device-id": "0b9f6f3e-8d4c-4a51-9a51-1c2d3e4f5a6b",
        "x-app-version": "1.4.0",
      });
      await get("/v1/me", { "x-device-id": "../../etc", "x-app-version": "1.4.0; drop" });
      expect(api.seen[0]?.headers).toMatchObject({
        "x-device-id": "0b9f6f3e-8d4c-4a51-9a51-1c2d3e4f5a6b",
        "x-app-version": "1.4.0",
      });
      expect(api.seen[1]?.headers["x-device-id"]).toBeUndefined();
      expect(api.seen[1]?.headers["x-app-version"]).toBeUndefined();
    });

    it("drops an upstream set-cookie named __Host-qs_player and keeps the others", async () => {
      api.answer(
        json(200, {}, { "set-cookie": ["__Host-qs_player=evil; Path=/", "__Host-qs_session=s"] }),
      );
      const response = await get("/v1/me", { cookie: oldCookie });
      expect(response.headers.getSetCookie()).toEqual(["__Host-qs_session=s"]);
    });

    it("drops the upstream player set-cookie on a sign-in error too", async () => {
      api.answer(
        json(
          422,
          { code: "invalid_code", message: { ar: "ر", en: "c" }, details: {} },
          {
            "set-cookie": "__Host-qs_player=evil; Path=/",
          },
        ),
      );
      const response = await post("/v1/auth/verify", verifyBody);
      expect(response.headers.getSetCookie()).toEqual([]);
    });
  });

  describe("the Origin rule", () => {
    it.each([
      ["missing", {}],
      ["foreign", { origin: "https://evil.example" }],
      ["a sibling subdomain", { origin: "https://kiosk.questify.test" }],
      ["null", { origin: "null" }],
    ])("refuses a %s Origin on a cookie write and on /v1/auth/*, calling nobody", async (_, h) => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const cookieWrite = await write("/v1/me/profile", { ...h, cookie: oldCookie }, method);
        expect(cookieWrite.status, method).toBe(403);
        expect(((await cookieWrite.json()) as { code: string }).code).toBe("csrf_rejected");
      }
      for (const path of ["/v1/auth/code", "/v1/auth/verify", "/v1/auth/refresh"]) {
        expect((await write(path, h)).status, path).toBe(403);
      }
      const malformed = await write("/v1/me/profile", { ...h, cookie: "__Host-qs_player=x" });
      expect(malformed.status).toBe(403);
      expect(api.seen).toEqual([]);
    });

    it("lets a GET through without an Origin, and a write without the cookie off /v1/auth", async () => {
      expect((await get("/v1/me", { cookie: oldCookie })).status).toBe(200);
      expect((await write("/v1/staff/auth/password", {})).status).toBe(200);
      expect((await write("/v1/me/profile", { origin: WEB, cookie: oldCookie })).status).toBe(200);
    });
  });

  it("logs no cookie or token on any failure", async () => {
    await forward(
      new Request(`${WEB}/v1/me?token=secret`, { headers: { cookie: oldCookie } }),
      options({ apiOrigin: "http://127.0.0.1:9" }),
    );
    expect(logged).toEqual([
      { event: "api_forward_failed", method: "GET", path: "/v1/me", reason: "unreachable" },
    ]);
  });
});

describe("the forwarder with PLAYER_WEB_SESSION off (the default)", () => {
  let api: Upstream;
  const options = (): ForwardOptions => ({
    apiOrigin: api.origin,
    timeoutMs: 2_000,
    maxBodyBytes: 4_096,
    log: () => undefined,
    webOrigin: WEB,
    playerSession: false,
    refuseConsoleApi: false,
  });
  const cookie = `__Host-qs_player=${token()}.${token()}`;

  beforeAll(async () => {
    api = await startUpstream();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(() => {
    api.seen.length = 0;
  });

  it("sets no cookie and turns none into a bearer; the sign-in steps pass through as before", async () => {
    const issued = { accessToken: token(), refreshToken: token(), expiresInSeconds: 3600 };
    api.answer(json(200, issued));
    const verify = await forward(
      new Request(`${WEB}/v1/auth/verify`, {
        method: "POST",
        headers: { origin: WEB },
        body: "{}",
      }),
      options(),
    );
    expect(verify.headers.getSetCookie()).toEqual([]);
    expect(api.seen[0]?.body).toBe("{}");
    await forward(new Request(`${WEB}/v1/me`, { headers: { cookie } }), options());
    expect(api.seen[1]?.headers["authorization"]).toBeUndefined();
    expect(api.seen[1]?.headers["cookie"]).toBeUndefined();
    const operator = await forward(
      new Request(`${WEB}/v1/operator/events`, { headers: { cookie } }),
      options(),
    );
    expect(operator.status).toBe(200);
  });

  it("still holds the Origin rule on /v1/auth/*", async () => {
    const refused = await forward(
      new Request(`${WEB}/v1/auth/code`, { method: "POST", body: "{}" }),
      options(),
    );
    expect(refused.status).toBe(403);
    expect(api.seen).toEqual([]);
  });
});
