import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let proxy: typeof import("#src/proxy.ts").proxy;

beforeAll(async () => {
  vi.stubEnv("API_ORIGIN", "http://127.0.0.1:4100");
  vi.stubEnv("DASHBOARD_ORIGIN", "https://questify.nafes.com");
  vi.stubEnv("CONSOLE_ORIGIN", "https://console.questify.nafes.com");
  vi.resetModules();
  ({ proxy } = await import("#src/proxy.ts"));
});
afterAll(() => {
  vi.unstubAllEnvs();
});

/** A page request as the edge hands it over: the URL is the internal one, the host is in `Host`. */
const page = (path: string, headers: Record<string, string>) =>
  new NextRequest(new URL(path, "http://0.0.0.0:3000"), { headers });

/**
 * The proxy's host step with the console on its own host (T-810d, ADR-722). `proxy.test.ts` runs with no
 * `CONSOLE_ORIGIN`, which is the app exactly as before.
 */
describe("the proxy's host step (T-810d)", () => {
  it("sends the console on the public host to the console host, query kept (old /console links)", () => {
    const response = proxy(page("/en/console/players?q=1", { host: "questify.nafes.com" }));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://console.questify.nafes.com/en/console/players?q=1",
    );
    expect(response.headers.get("content-security-policy")).not.toBeNull();
  });

  it("sends the console host's home to the console in the negotiated language", () => {
    const response = proxy(
      page("/", { host: "console.questify.nafes.com", "accept-language": "ar-SA,ar;q=0.9" }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://console.questify.nafes.com/ar/console");
  });

  it("sends a dashboard page and /play on the console host to the public host", () => {
    const response = proxy(page("/en/organizers", { host: "console.questify.nafes.com" }));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://questify.nafes.com/en/organizers");
    const play = proxy(page("/play?join=ABC", { host: "console.questify.nafes.com" }));
    expect(play.status).toBe(308);
    expect(play.headers.get("location")).toBe("https://questify.nafes.com/play?join=ABC");
  });

  it("serves the console on the console host, framed by nobody and calling only its own host", () => {
    const response = proxy(page("/en/console", { host: "console.questify.nafes.com" }));
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toMatch(/connect-src 'self'/);
  });

  it("treats a public Host with a client-sent x-forwarded-host of the console as public", () => {
    const response = proxy(
      page("/en/console", {
        host: "questify.nafes.com",
        "x-forwarded-host": "console.questify.nafes.com",
      }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://console.questify.nafes.com/en/console");
  });

  it("never redirects to the request's own Host: a forged host is public and stays on configured origins", () => {
    const response = proxy(page("/en/console", { host: "evil.example" }));
    expect(response.headers.get("location")).toBe("https://console.questify.nafes.com/en/console");
    const other = proxy(page("/en//evil.example", { host: "console.questify.nafes.com" }));
    expect(new URL(other.headers.get("location") ?? "").host).toBe("questify.nafes.com");
  });

  it("keeps the language step and /play on the public host", () => {
    const response = proxy(page("/", { host: "questify.nafes.com", "accept-language": "en" }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toMatch(/\/en$/);
    const play = proxy(page("/play", { host: "questify.nafes.com" }));
    expect(play.headers.get("location")).toBeNull();
  });
});
