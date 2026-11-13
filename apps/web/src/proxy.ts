import { NextResponse, type NextRequest } from "next/server";
import { splitHostConfig } from "#src/lib/config.ts";
import { consoleHome, hostKind, routeFor } from "#src/lib/console-host.ts";
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
  mediaSource,
  pageHeaders,
  playContentSecurityPolicy,
} from "#src/lib/security-headers.ts";

const languageOf = (request: NextRequest) =>
  negotiateLanguage(savedLanguage(request.cookies), request.headers.get("accept-language"));

/**
 * The host step (T-810d, ADR-722), before everything else: once the console has its own host, a page that belongs on
 * the other host goes there, on a configured origin, never one read from the request. With no console host configured
 * there is no step at all.
 */
function hostRedirect(request: NextRequest): NextResponse | undefined {
  const origins = splitHostConfig();
  if (origins === undefined) {
    return undefined;
  }
  const route = routeFor(hostKind(request.headers.get("host"), origins), request.nextUrl, origins);
  if (route.kind === "serve") {
    return undefined;
  }
  const target =
    route.kind === "redirect" ? route : consoleHome(route.consoleOrigin, languageOf(request));
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
  for (const cookie of languageCookieUpdates(request.cookies, first)) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

/**
 * Runs before every page: sends a page that belongs on the other host there (once the console has its own host,
 * T-810d), sends `/` to the right language, remembers the language a page is shown in, and adds the content-security
 * policy (with this request's nonce, which Next stamps on its own scripts) and the page headers. The kiosk pages and
 * `/play` alone may use the camera and compile their decoder's WebAssembly (ADR-245); links to them are full page
 * loads, so these headers are the ones the page runs under. `/play` (the player web build, T-803) has no language
 * prefix: the language redirect leaves it alone, and it gets its own policy with no nonce, since its page is a static
 * file. Every policy says `frame-ancestors 'none'`, so neither host can frame the other.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const play = isPlayPath(pathname);
  const nonce = btoa(crypto.randomUUID());
  const policy = play
    ? playContentSecurityPolicy()
    : contentSecurityPolicy(
        nonce,
        process.env.NODE_ENV === "development",
        isKioskPath(pathname),
        // The photo bucket (T-301b): the team's pages show its signed photos.
        mediaSource(process.env["MEDIA_HOST"]),
      );
  const response =
    hostRedirect(request) ?? (play ? NextResponse.next() : languageStep(request, policy, nonce));
  response.headers.set("content-security-policy", policy);
  for (const [name, value] of pageHeaders(pathname)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // Not the API forwarder (it answers `/v1/admin/*` itself on the public host once the console has its own host),
  // Next's own files, `.well-known`, or a file with a known asset extension (robots.txt, icons, the decoder's
  // WebAssembly, the `/play` build). A dot alone does not skip a path: a dynamic segment such as `/en/e/ABC.x` is a page
  // and still gets the page policy and `no-store`.
  matcher: [
    "/((?!v1(?:/|$)|_next/|\\.well-known/|.*\\.(?:avif|css|cjs|eot|gif|ico|jpe?g|js|json|map|mjs|otf|png|svg|ttf|txt|wasm|webmanifest|webp|woff2?|xml)$).*)",
  ],
};
