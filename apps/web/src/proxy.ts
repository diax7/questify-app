import { NextResponse, type NextRequest } from "next/server";
import {
  LANGUAGE_HEADER,
  isLanguage,
  languageCookieUpdates,
  negotiateLanguage,
  savedLanguage,
} from "#src/lib/language.ts";
import {
  contentSecurityPolicy,
  isKioskPath,
  isPlayPath,
  pageHeaders,
  playContentSecurityPolicy,
} from "#src/lib/security-headers.ts";

/**
 * Runs before every page: sends `/` to the right language, remembers the language a page is shown in, and adds the
 * content-security policy (with this request's nonce, which Next stamps on its own scripts) and the page headers. The
 * kiosk pages and `/play` alone may use the camera and compile their decoder's WebAssembly (ADR-245); links to them are
 * full page loads, so these headers are the ones the page runs under. `/play` (the player web build, T-803) has no
 * language prefix: the language redirect leaves it alone, and it gets its own policy with no nonce, since its page is a
 * static file.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const play = isPlayPath(pathname);
  const nonce = btoa(crypto.randomUUID());
  const policy = play
    ? playContentSecurityPolicy()
    : contentSecurityPolicy(nonce, process.env.NODE_ENV === "development", isKioskPath(pathname));

  const first = pathname.split("/")[1];
  let response: NextResponse;
  if (play) {
    response = NextResponse.next();
  } else if (pathname === "/") {
    const language = negotiateLanguage(
      savedLanguage(request.cookies),
      request.headers.get("accept-language"),
    );
    response = NextResponse.redirect(new URL(`/${language}`, request.url));
  } else if (!isLanguage(first)) {
    // A page without a language (an old link, a typed address) gets one rather than a dead end.
    const language = negotiateLanguage(
      savedLanguage(request.cookies),
      request.headers.get("accept-language"),
    );
    response = NextResponse.redirect(new URL(`/${language}${pathname}`, request.url));
  } else {
    const headers = new Headers(request.headers);
    headers.set("content-security-policy", policy);
    headers.set("x-nonce", nonce);
    // A page that gets no route params (a segment's not-found) reads its language here.
    headers.set(LANGUAGE_HEADER, first);
    response = NextResponse.next({ request: { headers } });
    for (const cookie of languageCookieUpdates(request.cookies, first)) {
      response.headers.append("set-cookie", cookie);
    }
  }
  response.headers.set("content-security-policy", policy);
  for (const [name, value] of pageHeaders(pathname)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // Not the API forwarder, Next's own files, `.well-known`, or any file with an extension (robots.txt, icons).
  matcher: ["/((?!v1(?:/|$)|_next/|\\.well-known/|.*\\.[a-zA-Z0-9]+$).*)"],
};
