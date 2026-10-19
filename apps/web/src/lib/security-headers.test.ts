import { describe, expect, it } from "vitest";
import { PAGE_HEADERS, contentSecurityPolicy } from "#src/lib/security-headers.ts";

describe("contentSecurityPolicy", () => {
  it("allows scripts only with this request's nonce in production, and nothing that evaluates text", () => {
    const policy = contentSecurityPolicy("abc123", false);
    expect(policy).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("ws:");
  });

  it("closes plugins, framing, base rewrites and foreign form targets", () => {
    const policy = contentSecurityPolicy("n", false);
    for (const rule of [
      "default-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "connect-src 'self'",
    ]) {
      expect(policy).toContain(rule);
    }
  });

  it("adds what hot reload needs only in development", () => {
    const policy = contentSecurityPolicy("n", true);
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain("connect-src 'self' ws:");
  });
});

describe("PAGE_HEADERS", () => {
  it("never lets a page be cached and turns off sniffing, referrers and device features", () => {
    expect(Object.fromEntries(PAGE_HEADERS)).toMatchObject({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    expect(Object.fromEntries(PAGE_HEADERS)["Permissions-Policy"]).toContain("camera=()");
  });
});
