import type { Language } from "@questify/shared";
import { isLanguage } from "#src/lib/language.ts";

/** Which host a request reached (T-810d, ADR-722). */
export type HostKind = "console" | "public";

export type HostOrigins = Readonly<{ dashboardOrigin: string; consoleOrigin: string }>;

export type HostRedirect = Readonly<{ kind: "redirect"; status: 307 | 308; location: string }>;

/** What the proxy does with a page path on its host. */
export type HostRoute =
  | Readonly<{ kind: "serve" }>
  /** `/` on the console host: the proxy negotiates the language, then sends it to that language's console. */
  | Readonly<{ kind: "console_home" }>
  | HostRedirect;

/**
 * The console host only when the `Host` header names it exactly (case aside, port included); anything else, a missing
 * header included, is the public host. Only `Host` is read: `x-forwarded-host` and the like come from the client unless
 * the edge sets them (Q-691).
 */
export function hostKind(host: string | null, origins: HostOrigins): HostKind {
  return host !== null && host.toLowerCase() === new URL(origins.consoleOrigin).host
    ? "console"
    : "public";
}

const CONSOLE_PATH = /^\/(?:ar|en)\/console(?:\/|$)/u;
/** The pages the console host serves besides the console: sign-in and the staff account page (Q-693). */
const CONSOLE_HOST_PAGE = /^\/(?:ar|en)\/(?:console|sign-in|account)(?:\/|$)/u;

/**
 * A redirect to the same path and query on a configured origin. Built by joining strings, never by resolving the path
 * against the origin, so a path such as `//evil.example` stays on the configured host (no open redirect).
 */
const onOrigin = (
  origin: string,
  pathname: string,
  search: string,
  status: 307 | 308,
): HostRedirect => ({ kind: "redirect", status, location: `${origin}${pathname}${search}` });

/**
 * Where a page path goes on each host (ADR-722): the public host sends the console to the console host; the console
 * host serves only the console, sign-in and the staff account page, sends its home to the console, and sends every
 * other page to the public host. A path without a language is left to the proxy's language step, which comes back here.
 */
export function routeFor(
  kind: HostKind,
  url: Readonly<{ pathname: string; search: string }>,
  origins: HostOrigins,
): HostRoute {
  const { pathname, search } = url;
  if (kind === "public") {
    return CONSOLE_PATH.test(pathname)
      ? onOrigin(origins.consoleOrigin, pathname, search, 308)
      : { kind: "serve" };
  }
  if (pathname === "/") {
    return { kind: "console_home" };
  }
  const first = pathname.split("/")[1];
  if (!isLanguage(first) || CONSOLE_HOST_PAGE.test(pathname)) {
    return { kind: "serve" };
  }
  if (pathname === `/${first}` || pathname === `/${first}/`) {
    return consoleHome(origins, first);
  }
  return onOrigin(origins.dashboardOrigin, pathname, search, 308);
}

/** The console's home in one language, on the console host. */
export const consoleHome = (origins: HostOrigins, language: Language): HostRedirect =>
  onOrigin(origins.consoleOrigin, `/${language}/console`, "", 307);
