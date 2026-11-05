import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "#src/proxy.ts";

const page = (path: string, cookie?: string, acceptLanguage?: string): NextRequest =>
  new NextRequest(`https://questify.example.test${path}`, {
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(acceptLanguage === undefined ? {} : { "accept-language": acceptLanguage }),
    },
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
