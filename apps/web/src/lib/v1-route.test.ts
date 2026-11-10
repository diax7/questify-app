import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startUpstream, type Upstream } from "#src/lib/upstream.test-support.ts";

const WEB = "https://app.questify.test";

const expectApiHeaders = (response: Response) => {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
};

type Route = typeof import("#src/app/v1/[[...path]]/route.ts");

describe("the /v1 route handler", () => {
  let api: Upstream;
  let route: Route;

  beforeAll(async () => {
    api = await startUpstream();
    vi.stubEnv("API_ORIGIN", api.origin);
    vi.stubEnv("DASHBOARD_ORIGIN", WEB);
    route = await import("#src/app/v1/[[...path]]/route.ts");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await api.close();
  });
  beforeEach(() => {
    api.seen.length = 0;
  });

  it("answers every method the browser can send, OPTIONS included", () => {
    const methods = Object.keys(route).filter((name) => /^[A-Z]+$/u.test(name));
    expect(methods.toSorted()).toEqual(["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"]);
  });

  it("forwards an OPTIONS request to the API and adds the security headers to its answer", async () => {
    const response = await route.OPTIONS(new Request(`${WEB}/v1/staff/me`, { method: "OPTIONS" }));
    expect(api.seen.map((request) => [request.method, request.url])).toEqual([
      ["OPTIONS", "/v1/staff/me"],
    ]);
    expectApiHeaders(response);
  });

  it("answers a bare /v1 with the API's not-found error and the security headers", async () => {
    const response = await route.GET(new Request(`${WEB}/v1`));
    expect(response.status).toBe(404);
    expect(api.seen).toEqual([]);
    expectApiHeaders(response);
  });
});
