import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { onlyRow } from "#src/db/rows";
import { myCode, type MyCodeKey } from "#src/quests/qr";
import { unauthenticated } from "#src/auth/http-errors";

export type MyQrDeps = Readonly<{ pool: Pool; myKey: MyCodeKey }>;

/** The caller's fixed My QR (ADR-137): their id and current version, signed. The app keeps it to show offline. */
export async function myQr(deps: MyQrDeps, playerId: string): Promise<string> {
  const version = await withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<{ v: number | null }>("SELECT my_qr_version() AS v");
      return onlyRow(rows, "my_qr_version").v;
    }),
  );
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard admits active players only
  if (version === null) {
    throw unauthenticated();
  }
  return myCode(deps.myKey, playerId, version);
}

/** A new code; every earlier one stops at once. Null at the daily limit (5 resets). */
export async function resetMyQr(
  deps: MyQrDeps,
  playerId: string,
  requestId: string,
): Promise<string | null> {
  const version = await withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<{ v: number | null }>("SELECT reset_my_qr($1) AS v", [
        requestId,
      ]);
      return onlyRow(rows, "reset_my_qr").v;
    }),
  );
  return version === null ? null : myCode(deps.myKey, playerId, version);
}
