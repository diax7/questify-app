import { NextResponse, type NextRequest } from "next/server";
import {
  LANGUAGE_COOKIE,
  isLanguage,
  languageCookie,
  negotiateLanguage,
} from "#src/lib/language.ts";
import { PAGE_HEADERS, contentSecurityPolicy } from "#src/lib/security-headers.ts";

/**
 * Runs before every page: sends `/` to the right language, remembers the language a page is shown in, and adds the
 * content-security policy (with this request's nonce, which Next stamps on its own scripts) and the page headers.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");

  let response: NextResponse;
  if (pathname === "/") {
    const language = negotiateLanguage(
      request.cookies.get(LANGUAGE_COOKIE)?.value,
      request.headers.get("accept-language"),
    );
    response = NextResponse.redirect(new URL(`/${language}`, request.url));
  } else if (!isLanguage(pathname.split("/")[1])) {
    // A page without a language (an old link, a typed address) gets one rather than a dead end.
    const language = negotiateLanguage(
      request.cookies.get(LANGUAGE_COOKIE)?.value,
      request.headers.get("accept-language"),
    );
    response = NextResponse.redirect(new URL(`/${language}${pathname}`, request.url));
  } else {
    const headers = new Headers(request.headers);
    headers.set("content-security-policy", policy);
    headers.set("x-nonce", nonce);
    response = NextResponse.next({ request: { headers } });
    const language = pathname.split("/")[1];
    if (isLanguage(language) && request.cookies.get(LANGUAGE_COOKIE)?.value !== language) {
      response.headers.append("set-cookie", languageCookie(language));
    }
  }
  response.headers.set("content-security-policy", policy);
  for (const [name, value] of PAGE_HEADERS) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // Not the API forwarder, Next's own files, `.well-known`, or any file with an extension (robots.txt, icons).
  matcher: ["/((?!v1(?:/|$)|_next/|\\.well-known/|.*\\.[a-zA-Z0-9]+$).*)"],
};
