import { isDeepStrictEqual } from "node:util";

/**
 * An audit entry is permanent, so it must never hold a secret or personal data (hard rule 3). Keys are compared
 * after lower-casing and dropping "_" and "-", so `password_hash`, `passwordHash` and `password-hash` all match.
 */
const SECRET_ENDINGS = [
  "password",
  "passwordhash",
  "secret",
  "token",
  "tokenhash",
  "codehash",
  "apikey",
];
const EXACT_KEYS = new Set([
  "code",
  "email",
  "phone",
  "phonee164",
  "ip",
  "useragent",
  "cookie",
  "authorization",
]);

const normalized = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");

function isForbiddenKey(key: string): boolean {
  const name = normalized(key);
  return EXACT_KEYS.has(name) || SECRET_ENDINGS.some((ending) => name.endsWith(ending));
}

const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/** True for a dotted lower-case action name such as `platform_settings.update`. */
export function isAction(action: string): boolean {
  return ACTION.test(action);
}

type Plain = Readonly<Record<string, unknown>>;

/** The top-level keys whose value changed, as the before and after the audit entry stores. */
export function diff(before: Plain, after: Plain): { before: Plain; after: Plain } {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const key of keys) {
    if (isDeepStrictEqual(before[key], after[key])) {
      continue;
    }
    if (key in before) {
      changedBefore[key] = before[key];
    }
    if (key in after) {
      changedAfter[key] = after[key];
    }
  }
  return { before: changedBefore, after: changedAfter };
}

/** The first key anywhere in the value that names a secret or personal data, or undefined. */
export function findSecretKey(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSecretKey(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (isForbiddenKey(key)) {
      return key;
    }
    const found = findSecretKey(inner);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
