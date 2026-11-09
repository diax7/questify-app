/** True for any non-null object (arrays included), the first check when reading an untrusted API answer. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
