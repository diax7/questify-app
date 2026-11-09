/**
 * What a paged list shows before its rows: "loading" while nothing has arrived and nothing failed, "empty" once an
 * empty page arrived, otherwise "ready" (rows, or a failure the notice already names).
 */
export function listStatus(
  items: readonly unknown[] | null,
  problem: string | null,
): "loading" | "empty" | "ready" {
  if (items === null && problem === null) {
    return "loading";
  }
  return items?.length === 0 ? "empty" : "ready";
}
