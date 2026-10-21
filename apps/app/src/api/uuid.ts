/**
 * A version-4 UUID for the install id and for Idempotency-Keys. Each is a key for limits or retries, not a secret, so
 * Math.random is enough here: Hermes does not promise `crypto.randomUUID`, and a crypto module would be a dependency
 * for nothing.
 */
export function randomUuid(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
