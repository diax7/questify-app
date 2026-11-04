/**
 * The security headers on every API answer (V3.4.1, V3.4.3, V3.4.4, ADR-700): set by the API itself and again by the
 * web host's `/v1` forwarder, so neither depends on the other. The API answers JSON and file downloads only, never
 * HTML, so a policy that allows nothing breaks nothing.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};
