import type { Language } from "@questify/shared";
import { isLanguage } from "#src/lib/language.ts";
import { isPlayPath } from "#src/lib/security-headers.ts";

/** Which host a request reached (T-810d, ADR-722). */
export type HostKind = "console" | "public";

/** The two origins, from the settings (`DASHBOARD_ORIGIN`, `CONSOLE_ORIGIN`); no console origin means one host. */
export type HostOrigins = Readonly<{ webOrigin: string; consoleOrigin: string | undefined }>;

export type HostRedirect = Readonly<{ kind: "redirect"; status: 307 | 308; location: string }>;

/** What the proxy does with a page path on its host. */
export type HostRoute =
  | Readonly<{ kind: "serve" }>
  /** `/` on the console host: the proxy negotiates the language, then sends it to that language's console. */
  | Readonly<{ kind: "console_home"; consoleOrigin: string }>
  | HostRedirect;

/**
 * The console host only when a console origin is set and the `Host` header names it exactly (case aside, port
 * included); anything else, a missing header included, is the public host. Only `Host` is read: `x-forwarded-host` and
 * the like come from the client unless the edge sets them (Q-691).
 */
export function hostKind(host: string | null, origins: HostOrigins): HostKind {
  return origins.consoleOrigin !== undefined &&
    host !== null &&
    host.toLowerCase() === new URL(origins.consoleOrigin).host
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

/** The console host: its console, sign-in and account pages; its home goes to the console; the rest to the public host. */
function consoleHostRoute(
  url: Readonly<{ pathname: string; search: string }>,
  origins: HostOrigins & { consoleOrigin: string },
): HostRoute {
  const { pathname, search } = url;
  if (pathname === "/") {
    return { kind: "console_home", consoleOrigin: origins.consoleOrigin };
  }
  if (isPlayPath(pathname)) {
    return onOrigin(origins.webOrigin, pathname, search, 308);
  }
  const first = pathname.split("/")[1];
  if (!isLanguage(first) || CONSOLE_HOST_PAGE.test(pathname)) {
    return { kind: "serve" };
  }
  if (pathname === `/${first}` || pathname === `/${first}/`) {
    return consoleHome(origins.consoleOrigin, first);
  }
  return onOrigin(origins.webOrigin, pathname, search, 308);
}

/**
 * Where a page path goes on each host (ADR-722). With no console origin set, every page is served as before T-810d.
 * With one, the public host sends the console to the console host (old `/console` links keep working); the console host
 * serves only the console, sign-in and the staff account page, sends its home to the console, and sends every other
 * page, `/play` included, to the public host. A path without a language is left to the proxy's language step, which
 * comes back here.
 */
export function routeFor(
  kind: HostKind,
  url: Readonly<{ pathname: string; search: string }>,
  origins: HostOrigins,
): HostRoute {
  const { consoleOrigin } = origins;
  if (consoleOrigin === undefined) {
    return { kind: "serve" };
  }
  if (kind === "console") {
    return consoleHostRoute(url, { ...origins, consoleOrigin });
  }
  return CONSOLE_PATH.test(url.pathname)
    ? onOrigin(consoleOrigin, url.pathname, url.search, 308)
    : { kind: "serve" };
}

/** The console's home in one language, on the console host. */
export const consoleHome = (consoleOrigin: string, language: Language): HostRedirect =>
  onOrigin(consoleOrigin, `/${language}/console`, "", 307);

/**
 * A link to a console page from a public page: absolute on the console host once it has one, relative as before
 * otherwise. `path` starts with `/{lang}/console`.
 */
export const consoleHref = (origins: HostOrigins, path: string): string =>
  `${origins.consoleOrigin ?? ""}${path}`;

/**
 * A link to a dashboard page from a console page: absolute on the public host once the console has its own host,
 * relative as before otherwise.
 */
export const dashboardHref = (origins: HostOrigins, path: string): string =>
  origins.consoleOrigin === undefined ? path : `${origins.webOrigin}${path}`;
