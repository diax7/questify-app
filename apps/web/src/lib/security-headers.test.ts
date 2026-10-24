import { describe, expect, it } from "vitest";
import {
  PAGE_HEADERS,
  contentSecurityPolicy,
  isKioskPath,
  pageHeaders,
} from "#src/lib/security-headers.ts";

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

describe("the kiosk pages (T-309b, ADR-245)", () => {
  it("are the two exact paths, never a sub-path or another page", () => {
    expect(isKioskPath("/ar/kiosk")).toBe(true);
    expect(isKioskPath("/en/kiosk")).toBe(true);
    for (const path of [
      "/en/kiosk/x",
      "/en/kiosks",
      "/en/station",
      "/kiosk",
      "/fr/kiosk",
      "/en/kiosk/",
    ]) {
      expect(isKioskPath(path), path).toBe(false);
    }
  });

  it("alone may use the camera, and nothing else", () => {
    const kiosk = Object.fromEntries(pageHeaders("/en/kiosk"))["Permissions-Policy"];
    expect(kiosk).toBe("camera=(self), microphone=(), geolocation=(), payment=(), usb=()");
    expect(Object.fromEntries(pageHeaders("/en/station"))["Permissions-Policy"]).toContain(
      "camera=()",
    );
    expect(pageHeaders("/ar/sign-in")).toBe(PAGE_HEADERS);
    expect(Object.fromEntries(pageHeaders("/ar/kiosk"))["Cache-Control"]).toBe("no-store");
  });

  it("alone may compile WebAssembly, never evaluate text", () => {
    const kiosk = contentSecurityPolicy("n", false, true);
    expect(kiosk).toContain("script-src 'self' 'nonce-n' 'strict-dynamic' 'wasm-unsafe-eval'");
    expect(kiosk).not.toContain("'unsafe-eval'");
    expect(kiosk).toContain("connect-src 'self'");
    expect(contentSecurityPolicy("n", false)).not.toContain("wasm-unsafe-eval");
  });
});
