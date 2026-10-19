import { createHash } from "node:crypto";

/** A strong ETag for a JSON document: the same document always gives the same tag, any change gives another. */
export function etagOf(document: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(document)).digest("hex").slice(0, 32)}"`;
}

/** True when the If-None-Match header names this tag (a list, a weak tag or "*" all count). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}
