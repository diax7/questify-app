import { NextResponse, type NextRequest } from "next/server";
import { webConfig } from "#src/lib/config.ts";
import { consoleHome, hostKind, routeFor } from "#src/lib/console-host.ts";
import {
  LANGUAGE_COOKIE,
  LANGUAGE_HEADER,
  isLanguage,
  languageCookie,
  negotiateLanguage,
} from "#src/lib/language.ts";
import { contentSecurityPolicy, isKioskPath, pageHeaders } from "#src/lib/security-headers.ts";

const languageOf = (request: NextRequest) =>
  negotiateLanguage(
    request.cookies.get(LANGUAGE_COOKIE)?.value,
    request.headers.get("accept-language"),
  );

/**
 * The host step (T-810d, ADR-722), before the language step: a page that belongs on the other host goes there, on a
 * configured origin, never one read from the request.
 */
function hostRedirect(request: NextRequest): NextResponse | undefined {
  const origins = webConfig();
  const route = routeFor(hostKind(request.headers.get("host"), origins), request.nextUrl, origins);
  if (route.kind === "serve") {
    return undefined;
  }
  const target = route.kind === "redirect" ? route : consoleHome(origins, languageOf(request));
  return NextResponse.redirect(target.location, target.status);
}

/** The language step: `/` and a path without a language get one; a page in a language is served with its headers. */
function languageStep(request: NextRequest, policy: string, nonce: string): NextResponse {
  const { pathname } = request.nextUrl;
  const first = pathname.split("/")[1];
  if (pathname === "/") {
    return NextResponse.redirect(new URL(`/${languageOf(request)}`, request.url));
  }
  if (!isLanguage(first)) {
    // A page without a language (an old link, a typed address) gets one rather than a dead end.
    return NextResponse.redirect(new URL(`/${languageOf(request)}${pathname}`, request.url));
  }
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  headers.set("x-nonce", nonce);
  // A page that gets no route params (a segment's not-found) reads its language here.
  headers.set(LANGUAGE_HEADER, first);
  const response = NextResponse.next({ request: { headers } });
  if (request.cookies.get(LANGUAGE_COOKIE)?.value !== first) {
    response.headers.append("set-cookie", languageCookie(first));
  }
  return response;
}

/**
 * Runs before every page: sends a page that belongs on the other host there (the console has its own host, T-810d),
 * sends `/` to the right language, remembers the language a page is shown in, and adds the
 * content-security policy (with this request's nonce, which Next stamps on its own scripts) and the page headers. The
 * kiosk pages alone may use the camera and compile their decoder's WebAssembly (ADR-245); links to them are full page
 * loads, so these headers are the ones the page runs under.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
    isKioskPath(pathname),
  );

  const response = hostRedirect(request) ?? languageStep(request, policy, nonce);
  response.headers.set("content-security-policy", policy);
  for (const [name, value] of pageHeaders(pathname)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // Not the API forwarder (it answers `/v1/admin/*` itself on the public host), Next's own files, `.well-known`, or any
  // file with an extension (robots.txt, icons). A path whose last part has a dot skips the host step too, so no page
  // path (an event code, a slug) ever contains one (T-810d).
  matcher: ["/((?!v1(?:/|$)|_next/|\\.well-known/|.*\\.[a-zA-Z0-9]+$).*)"],
};
