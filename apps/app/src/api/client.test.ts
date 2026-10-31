import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiBaseUrl, createClient } from "#src/api/client.ts";

type Call = { url: string; init: RequestInit | undefined };

function answering(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const clientWith = (fetchImpl: typeof fetch) =>
  createClient({
    baseUrl: "https://api.test",
    deviceId: async () => "8d5b3c33-1f8e-4f3a-9a2e-0b1c2d3e4f50",
    language: () => "ar",
    fetchImpl,
  });

describe("apiBaseUrl", () => {
  it("defaults to staging in development only", () => {
    expect(apiBaseUrl(undefined, true)).toBe("https://questify-api-staging-3ez01s.cranl.net");
    expect(apiBaseUrl("", true)).toBe("https://questify-api-staging-3ez01s.cranl.net");
    expect(() => apiBaseUrl(undefined, false)).toThrow(/EXPO_PUBLIC_API_URL is not set/);
    expect(() => apiBaseUrl("", false)).toThrow(/EXPO_PUBLIC_API_URL is not set/);
  });

  it("keeps an https origin, and plain http only in development", () => {
    expect(apiBaseUrl("https://api.questify.sa/v1/", false)).toBe("https://api.questify.sa");
    expect(apiBaseUrl("http://192.168.1.5:3000", true)).toBe("http://192.168.1.5:3000");
    expect(() => apiBaseUrl("http://api.questify.sa", false)).toThrow(
      /must be https in a release build/,
    );
    expect(() => apiBaseUrl("not a url", false)).toThrow(/is not a URL/);
  });
});

describe("createClient", () => {
  it("sends the install id, the language, JSON and the access token", async () => {
    const api = answering(200, { ok: true });
    const result = await clientWith(api.fetchImpl).request({
      method: "POST",
      path: "/v1/join",
      body: { joinCode: "ABC234" },
      accessToken: "token-1",
    });
    expect(result).toMatchObject({ kind: "ok", status: 200, body: { ok: true } });
    expect(api.calls[0]?.url).toBe("https://api.test/v1/join");
    expect(api.calls[0]?.init?.method).toBe("POST");
    expect(api.calls[0]?.init?.body).toBe('{"joinCode":"ABC234"}');
    const sent = new Headers(api.calls[0]?.init?.headers);
    expect(sent.get("x-device-id")).toBe("8d5b3c33-1f8e-4f3a-9a2e-0b1c2d3e4f50");
    expect(sent.get("accept")).toBe("application/json");
    expect(sent.get("accept-language")).toBe("ar");
    expect(sent.get("content-type")).toBe("application/json");
    expect(sent.get("authorization")).toBe("Bearer token-1");
  });

  it("names the build's version for the API's update gate, and sends none when it has none", async () => {
    const api = answering(200, {});
    const named = createClient({
      baseUrl: "https://api.test",
      deviceId: async () => "8d5b3c33-1f8e-4f3a-9a2e-0b1c2d3e4f50",
      language: () => "ar",
      appVersion: "1.2.3",
      fetchImpl: api.fetchImpl,
    });
    await named.request({ method: "GET", path: "/v1/config" });
    await clientWith(api.fetchImpl).request({ method: "GET", path: "/v1/config" });
    expect(new Headers(api.calls[0]?.init?.headers).get("x-app-version")).toBe("1.2.3");
    expect(new Headers(api.calls[1]?.init?.headers).has("x-app-version")).toBe(false);
  });

  it("is configured with a version the API's default minimum (1.0.0) lets through", () => {
    const config = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../app.json"), "utf8"),
    ) as {
      expo: { version: string };
    };
    expect(config.expo.version).toMatch(/^[0-9]+(\.[0-9]+){1,2}$/);
    expect(Number(config.expo.version.split(".")[0])).toBeGreaterThanOrEqual(1);
  });

  it("sends no body, content type or token when there are none", async () => {
    const api = answering(200, {});
    await clientWith(api.fetchImpl).request({ method: "GET", path: "/v1/config" });
    const sent = new Headers(api.calls[0]?.init?.headers);
    expect(sent.has("content-type")).toBe(false);
    expect(sent.has("authorization")).toBe(false);
    expect(api.calls[0]?.init?.body).toBeUndefined();
  });

  it("reads an error's code, message in both languages and details", async () => {
    const api = answering(422, {
      code: "invalid_code",
      message: { ar: "الرمز غير صحيح.", en: "That code is not correct." },
      details: { attemptsLeft: 2 },
    });
    expect(
      await clientWith(api.fetchImpl).request({ method: "POST", path: "/x", body: {} }),
    ).toMatchObject({
      kind: "error",
      status: 422,
      code: "invalid_code",
      message: { ar: "الرمز غير صحيح.", en: "That code is not correct." },
      details: { attemptsLeft: 2 },
    });
  });

  it("names an error with no envelope as unknown, without inventing a message", async () => {
    for (const body of [
      undefined,
      null,
      "oops",
      { code: 3, message: { en: "x" }, details: "no" },
      { code: 4, message: { ar: "x" } },
    ]) {
      const api = answering(502, body);
      expect(await clientWith(api.fetchImpl).request({ method: "GET", path: "/x" })).toMatchObject({
        kind: "error",
        status: 502,
        code: "unknown_error",
        message: null,
        details: {},
      });
    }
  });

  it("answers a 204 with no body, and a dropped connection as network", async () => {
    expect(
      await clientWith(answering(204, undefined).fetchImpl).request({ method: "POST", path: "/x" }),
    ).toMatchObject({
      kind: "ok",
      status: 204,
      body: undefined,
    });
    const failing = (async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    expect(await clientWith(failing).request({ method: "GET", path: "/x" })).toEqual({
      kind: "network",
    });
  });

  it("gives up after its timeout and answers network", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const client = createClient({
      baseUrl: "https://api.test",
      deviceId: async () => "d",
      language: () => "en",
      fetchImpl: hanging,
      timeoutMs: 20,
    });
    expect(await client.request({ method: "GET", path: "/slow" })).toEqual({ kind: "network" });
  });

  it("gives up when the body stalls after the headers, and answers network", async () => {
    const stalling = (async (_url: string, init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      }) as unknown as Response) as unknown as typeof fetch;
    const client = createClient({
      baseUrl: "https://api.test",
      deviceId: async () => "d",
      language: () => "en",
      fetchImpl: stalling,
      timeoutMs: 20,
    });
    expect(await client.request({ method: "GET", path: "/slow-body" })).toEqual({
      kind: "network",
    });
  });

  it("answers network when the install id cannot be read, sending nothing", async () => {
    const api = answering(200, {});
    const client = createClient({
      baseUrl: "https://api.test",
      deviceId: async () => {
        throw new Error("storage");
      },
      language: () => "en",
      fetchImpl: api.fetchImpl,
    });
    expect(await client.request({ method: "GET", path: "/v1/config" })).toEqual({
      kind: "network",
    });
    expect(api.calls).toEqual([]);
  });
});
