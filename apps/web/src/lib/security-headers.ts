/**
 * The content-security policy for every page. Scripts run only with this request's nonce (and what they load);
 * development adds `unsafe-eval` and websockets for hot reload, never production.
 */
export function contentSecurityPolicy(nonce: string, development: boolean): string {
  const scripts = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
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

/** Sent with every page. Pages carry personal data once signed in, so nothing is cached. */
export const PAGE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
  ["Cache-Control", "no-store"],
];
