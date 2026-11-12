import { describe, expect, it } from "vitest";
import {
  PAGE_HEADERS,
  contentSecurityPolicy,
  mediaSource,
  isKioskPath,
  isPlayPath,
  pageHeaders,
  playContentSecurityPolicy,
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

  it("shows pictures from the photo bucket's one host only when it is set (T-301b)", () => {
    expect(contentSecurityPolicy("n", false)).toContain("img-src 'self' data:;");
    const media = mediaSource("Questify-Media-Staging.s3.riyadh-1.example.test");
    expect(media).toBe("https://questify-media-staging.s3.riyadh-1.example.test");
    expect(contentSecurityPolicy("n", false, false, media)).toContain(
      "img-src 'self' data: https://questify-media-staging.s3.riyadh-1.example.test;",
    );
    expect(mediaSource("s3.example.test:9443")).toBe("https://s3.example.test:9443");
    for (const bad of [
      undefined,
      "",
      "*",
      "*.example.test",
      "https://s3.example.test",
      "s3.example.test/path",
      "s3 example.test",
      "localhost",
      "s3.example.test; script-src *",
    ]) {
      expect(mediaSource(bad), String(bad)).toBeUndefined();
    }
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

  it("sends HSTS for a year with subdomains on every page, the kiosk pages included", () => {
    for (const path of ["/en/station", "/en/kiosk"]) {
      expect(Object.fromEntries(pageHeaders(path))["Strict-Transport-Security"], path).toBe(
        "max-age=31536000; includeSubDomains",
      );
    }
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

describe("the player web build at /play (T-803 P3, FR-1816)", () => {
  it("covers /play and its pages, never a lookalike", () => {
    for (const path of ["/play", "/play/", "/play/event/1"]) {
      expect(isPlayPath(path), path).toBe(true);
    }
    for (const path of ["/", "/en/play", "/player", "/playground", "/en/kiosk"]) {
      expect(isPlayPath(path), path).toBe(false);
    }
  });

  it("runs only scripts of this origin and WebAssembly, with no nonce and nothing that evaluates text", () => {
    const policy = playContentSecurityPolicy();
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(policy).not.toMatch(/nonce|strict-dynamic|'unsafe-eval'/u);
  });

  it("lets styles be inline and pictures be data or blob, and keeps the rest closed", () => {
    const rules = playContentSecurityPolicy().split("; ");
    for (const rule of [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ]) {
      expect(rules, rule).toContain(rule);
    }
  });

  it("allows the camera and location for this origin on /play only, microphone never", () => {
    const play = Object.fromEntries(pageHeaders("/play"))["Permissions-Policy"];
    expect(play).toBe("camera=(self), microphone=(), geolocation=(self), payment=(), usb=()");
    expect(Object.fromEntries(pageHeaders("/play/x"))["Permissions-Policy"]).toBe(play);
    for (const path of ["/en/sign-in", "/en/kiosk", "/ar/station"]) {
      expect(Object.fromEntries(pageHeaders(path))["Permissions-Policy"], path).not.toContain(
        "geolocation=(self)",
      );
    }
  });

  it("keeps index.html out of every cache and sends the other page headers", () => {
    expect(Object.fromEntries(pageHeaders("/play"))).toMatchObject({
      "Cache-Control": "no-store",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
  });
});
