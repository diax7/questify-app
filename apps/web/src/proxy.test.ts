import { JOIN_CODE, SURVEY_SHARE_TOKEN } from "@questify/shared";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "#src/proxy.ts";

const page = (path: string, cookie?: string, acceptLanguage?: string): NextRequest =>
  new NextRequest(`https://questify.example.test${path}`, {
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(acceptLanguage === undefined ? {} : { "accept-language": acceptLanguage }),
    },
  });

describe("the player web build at /play (T-803 P3)", () => {
  it.each(["/play", "/play/", "/play/event/9"])("%s is not sent to a language", (path) => {
    const response = proxy(page(path, "qs_lang=ar", "ar-SA"));
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("answers with its own policy, the camera and location, and no cache", () => {
    const response = proxy(page("/play"));
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(policy).not.toContain("nonce");
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(self), microphone=(), geolocation=(self), payment=(), usb=()",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves the pages of the dashboard on their own policy and without location", () => {
    const response = proxy(page("/en/sign-in"));
    expect(response.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(response.headers.get("permissions-policy")).toContain("geolocation=()");
  });
});

describe("the language the proxy remembers", () => {
  it("sets the __Host- cookie for a page shown in a language the browser has no cookie for", () => {
    const response = proxy(page("/en/sign-in"));
    expect(response.headers.getSetCookie()).toEqual([
      "__Host-qs_lang=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    ]);
  });

  it("sets nothing again while the cookie holds the page's language", () => {
    const response = proxy(page("/ar/sign-in", "__Host-qs_lang=ar"));
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("sends a visit to / to the language saved under the old name", () => {
    const response = proxy(page("/", "qs_lang=ar", "en-US"));
    expect(response.headers.get("location")).toBe("https://questify.example.test/ar");
  });

  it("sends a page without a language to the saved language, the prefixed cookie first", () => {
    const response = proxy(page("/console/tickets", "qs_lang=ar; __Host-qs_lang=en"));
    expect(response.headers.get("location")).toBe(
      "https://questify.example.test/en/console/tickets",
    );
  });

  it("moves a choice from the old cookie to the new one on the next page", () => {
    const response = proxy(page("/ar/sign-in", "qs_lang=ar"));
    expect(response.headers.getSetCookie()).toEqual([
      "__Host-qs_lang=ar; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
      "qs_lang=; Path=/; Max-Age=0; SameSite=Lax; Secure",
    ]);
  });

  it("follows the browser's language when no cookie is saved", () => {
    const response = proxy(page("/", undefined, "ar-SA,en;q=0.5"));
    expect(response.headers.get("location")).toBe("https://questify.example.test/ar");
  });
});

describe("which paths the proxy runs for", () => {
  const { matcher } = config;
  const runsFor = (path: string): boolean => {
    const source = matcher[0] ?? "";
    return new RegExp(`^${source}$`, "u").test(path);
  };

  it("skips the API forwarder, Next's files and real static files", () => {
    for (const path of [
      "/v1/me",
      "/v1",
      "/_next/static/chunks/a.js",
      "/.well-known/security.txt",
      "/favicon.ico",
      "/robots.txt",
      "/brand/logo.png",
      "/avatars/a.webp",
      "/zxing/zxing_reader.wasm",
      "/play/_expo/static/js/web/entry-1a2b.js",
    ]) {
      expect(runsFor(path), path).toBe(false);
    }
  });

  it("runs for pages, including a dynamic segment with a dot", () => {
    for (const path of [
      "/",
      "/en/sign-in",
      "/en/e/ABC.x",
      "/ar/e/A.B.C",
      "/en/s/tok.en.html",
      "/play",
      "/v10/x",
    ]) {
      expect(runsFor(path), path).toBe(true);
    }
  });

  it("gives a dotted page address the page policy and no-store", () => {
    const response = proxy(page("/en/e/ABC.x"));
    expect(response.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the page segments the matcher leaves to the proxy", () => {
  // The matcher skips a path ending in a listed asset extension, so a page segment that could end in one would lose
  // the page policy. The join code and the survey share token are such segments: their alphabets have no dot.
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  const extensions = /\.\(\?:([^)]*)\)\$/.exec(config.matcher[0] ?? "")?.[1]?.split("|") ?? [];

  it("finds the asset extensions in the matcher", () => {
    expect(extensions).toContain("js");
    expect(extensions).toContain("png");
    expect(matcher.test("/en/e/ABC234")).toBe(true);
    expect(matcher.test("/en/s/ABC234.js")).toBe(false);
  });

  it("never lets a join code or a share token carry a dot", () => {
    expect(JOIN_CODE.test("ABC234")).toBe(true);
    expect(JOIN_CODE.test("ABC.js")).toBe(false);
    expect(SURVEY_SHARE_TOKEN.test("A".repeat(43))).toBe(true);
    expect(SURVEY_SHARE_TOKEN.test(`${"A".repeat(40)}.js`)).toBe(false);
    for (const pattern of [JOIN_CODE, SURVEY_SHARE_TOKEN]) {
      expect(pattern.source).not.toContain(".");
      expect(pattern.source).not.toMatch(/\\S|\\W|\[\^/);
    }
  });

  it.each(extensions)("a code or token cannot end in .%s", (extension) => {
    expect(JOIN_CODE.test(`ABC.${extension}`)).toBe(false);
    expect(SURVEY_SHARE_TOKEN.test(`${"A".repeat(43 - extension.length - 1)}.${extension}`)).toBe(
      false,
    );
  });
});
