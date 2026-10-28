/** What the API says before a hint is sent: how many members would be told, and whether the last hint is still on its way. */
export type HintPreview = Readonly<{ members: number; pending: boolean }>;

/** Reads `GET …/categories/{id}/hint`'s body, or undefined when it is not the shape the API sends. */
export function hintPreviewOf(body: unknown): HintPreview | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { members, pending } = body as Record<string, unknown>;
  if (typeof members !== "number" || !Number.isInteger(members) || members < 0) {
    return undefined;
  }
  return typeof pending === "boolean" ? { members, pending } : undefined;
}
