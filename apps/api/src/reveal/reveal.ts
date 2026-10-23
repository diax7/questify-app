import type { Caller } from "#src/auth/sign-in";
import { run, type Bilingual, type Done, type PlayDeps } from "#src/plays/run";
import { verifyRevealCode, type RevealCodeKey } from "#src/quests/qr";

export type RevealDeps = PlayDeps & Readonly<{ revealKey: RevealCodeKey }>;

export type RevealRequest = Readonly<{
  playerId: string;
  categoryId: string;
  /** The token the app read from the category's /q/{token} address. */
  code: string;
}>;

/** A find's answer (T-304c, FR-237): the category now shown, and false when this player had found it before. */
export type Revealed = Readonly<{ categoryId: string; name: Bilingual; revealed: boolean }>;

type RevealRow = Readonly<{
  category_id: string;
  name_ar: string | null;
  name_en: string | null;
  revealed: boolean;
}>;

/**
 * Reveals a hidden category to the calling player. The code's signature and its category are checked before any
 * database read, so every other refusal (not found, not hidden, not live, outside the audience) is only ever answered
 * to someone holding this category's real code; `reveal_category` checks the rest and pays nothing (ADR-204).
 */
export async function revealCategory(
  deps: RevealDeps,
  request: RevealRequest,
  caller: Caller,
): Promise<Done<Revealed>> {
  const check = verifyRevealCode(deps.revealKey, request.code, request.categoryId);
  if (check.kind !== "valid") {
    return refused(caller, request.categoryId, { kind: "invalid_code", problem: check.kind });
  }
  const result = await run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<RevealRow>("SELECT * FROM reveal_category($1, $2)", [
      check.categoryId,
      check.version,
    ]);
    const row = rows[0] as RevealRow;
    return {
      categoryId: row.category_id,
      name: { ar: row.name_ar, en: row.name_en },
      revealed: row.revealed,
    };
  });
  if (result.kind !== "done") {
    return refused(caller, request.categoryId, result);
  }
  caller.log("category.revealed", {
    categoryId: result.value.categoryId,
    revealed: String(result.value.revealed),
  });
  return result;
}

/** Logs a refusal with its reason (a spike of forged codes is worth a look, RUNBOOK); never the token. */
function refused<T extends Exclude<Done<unknown>, { kind: "done" }>>(
  caller: Caller,
  categoryId: string,
  result: T,
): T {
  const reason =
    result.kind === "invalid_code"
      ? result.problem
      : result.kind === "quest_not_open" || result.kind === "enrollment_inactive"
        ? result.reason
        : result.kind;
  caller.log("category.reveal_refused", { categoryId, refusal: result.kind, reason });
  return result;
}
