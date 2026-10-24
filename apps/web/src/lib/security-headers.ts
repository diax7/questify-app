/**
 * The content-security policy for every page. Scripts run only with this request's nonce (and what they load);
 * development adds `unsafe-eval` and websockets for hot reload, never production. `wasm` (the kiosk page only, ADR-245)
 * lets the page compile WebAssembly, its QR decoder, and nothing else that evaluates text.
 */
export function contentSecurityPolicy(nonce: string, development: boolean, wasm = false): string {
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
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connections.join(" ")}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
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

/** The page headers for `pathname`: every page's, with the camera allowed for this origin on a kiosk page only. */
export function pageHeaders(pathname: string): ReadonlyArray<readonly [string, string]> {
  if (!isKioskPath(pathname)) {
    return PAGE_HEADERS;
  }
  return PAGE_HEADERS.map(([name, value]) =>
    name === "Permissions-Policy"
      ? [name, "camera=(self), microphone=(), geolocation=(), payment=(), usb=()"]
      : [name, value],
  );
}
