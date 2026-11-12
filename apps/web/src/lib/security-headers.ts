/**
 * The content-security policy for every page. Scripts run only with this request's nonce (and what they load);
 * development adds `unsafe-eval` and websockets for hot reload, never production. `wasm` (the kiosk page only, ADR-245)
 * lets the page compile WebAssembly, its QR decoder, and nothing else that evaluates text.
 */
export function contentSecurityPolicy(
  nonce: string,
  development: boolean,
  wasm = false,
  media?: string,
): string {
  const scripts = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (wasm) {
    scripts.push("'wasm-unsafe-eval'");
  }
  const connections = ["'self'"];
  if (development) {
    scripts.push("'unsafe-eval'");
    connections.push("ws:");
  }
  return [
    "default-src 'self'",
    `script-src ${scripts.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    media === undefined ? "img-src 'self' data:" : `img-src 'self' data: ${media}`,
    "font-src 'self'",
    `connect-src ${connections.join(" ")}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

const HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?$/;

/**
 * The photo bucket's origin for `img-src` (T-301b): `MEDIA_HOST` is a host name (and port), never a scheme, path or
 * wildcard, so the team's pages show the signed photos from that one host over https. Anything else adds nothing.
 */
export function mediaSource(host: string | undefined): string | undefined {
  const value = host?.trim().toLowerCase();
  return value !== undefined && HOST.test(value) ? `https://${value}` : undefined;
}

/** The kiosk pages (T-309b): the exact paths, never a sub-path, are the only ones that may use the camera and wasm. */
const KIOSK_PATHS: ReadonlySet<string> = new Set(["/ar/kiosk", "/en/kiosk"]);

/** Whether `pathname` is a kiosk page, which alone gets the camera and WebAssembly (ADR-245). */
export const isKioskPath = (pathname: string): boolean => KIOSK_PATHS.has(pathname);

/** Sent with every page. Pages carry personal data once signed in, so nothing is cached. */
export const PAGE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
  ["Cache-Control", "no-store"],
];

/**
 * The player web build at `/play` (T-803 P3, FR-1816) is a static page: its scripts are files of this origin, with no
 * inline script and no nonce (the export is built ahead of time), so `script-src` names no nonce and no
 * `strict-dynamic`. `wasm-unsafe-eval` is for the QR decoder's WebAssembly (`/zxing/`), nothing else that evaluates
 * text. react-native-web writes style rules at run time, so styles may be inline; pictures may be `data:` and `blob:`;
 * the page talks only to its own origin, where the forwarder sits.
 */
export function playContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** The player web build: `/play` and the pages under it (files with an extension skip the proxy). */
export const isPlayPath = (pathname: string): boolean =>
  pathname === "/play" || pathname.startsWith("/play/");

const KIOSK_PERMISSIONS = "camera=(self), microphone=(), geolocation=(), payment=(), usb=()";
/** `/play`: the camera (QR scan quests) and location (location quests) for this origin only. */
const PLAY_PERMISSIONS = "camera=(self), microphone=(), geolocation=(self), payment=(), usb=()";

const withPermissions = (policy: string): ReadonlyArray<readonly [string, string]> =>
  PAGE_HEADERS.map(([name, value]) => [name, name === "Permissions-Policy" ? policy : value]);

/**
 * The page headers for `pathname`: every page's, with the camera allowed for this origin on a kiosk page and on `/play`
 * (which adds location). `/play` stays `no-store`, so a release reaches the next page load.
 */
export function pageHeaders(pathname: string): ReadonlyArray<readonly [string, string]> {
  if (isPlayPath(pathname)) {
    return withPermissions(PLAY_PERMISSIONS);
  }
  return isKioskPath(pathname) ? withPermissions(KIOSK_PERMISSIONS) : PAGE_HEADERS;
}
