import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { ClaimedSend } from "#src/push/message";
import type { PushTarget } from "#src/push/provider";

/** What one wave's acknowledgement records for a row (push_ack, migration 0076). */
export type AckOutcome = "sent" | "unknown" | "failed" | "requeue" | "invalid";

export type AckRow = Readonly<{
  id: string;
  lease: string;
  outcome: AckOutcome;
  /** A provider code or a reason (`deadline`, `hold`, `no_template`), never a token or text. */
  code: string | null;
  /** Requests written for this row so far, in total. */
  attempts: number;
}>;

export type FanOutResult = Readonly<{ rows: number; more: boolean }>;

/** The push worker's four system doors; the unit tests replace them. */
export type PushDoors = Readonly<{
  fanOut: () => Promise<FanOutResult>;
  claim: (targets: readonly PushTarget[], size: number) => Promise<ClaimedSend[]>;
  ack: (rows: readonly AckRow[]) => Promise<number>;
  settle: () => Promise<Readonly<Record<string, unknown>>>;
}>;

const system = <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> =>
  withConnection(pool, (client) => withRequestContext(client, {}, () => work(client)));

/**
 * The doors on the worker's own pool, each in its own transaction in the system context (no player, staff, admin or
 * device), which the database checks again (PN403 `system_only`).
 */
export function createPushDoors(pool: Pool): PushDoors {
  return {
    fanOut: () =>
      system(pool, async (client) => {
        const { rows } = await client.query<{ r: FanOutResult }>("SELECT push_fan_out() AS r");
        return rows[0]?.r ?? { rows: 0, more: false };
      }),
    claim: (targets, size) =>
      system(pool, async (client) => {
        const { rows } = await client.query<ClaimedSend>("SELECT * FROM push_claim($1, $2)", [
          [...targets],
          size,
        ]);
        return rows;
      }),
    ack: (rows) =>
      system(pool, async (client) => {
        const { rows: answer } = await client.query<{ n: number }>(
          "SELECT push_ack($1::bigint[], $2::uuid[], $3::text[], $4::text[], $5::smallint[]) AS n",
          [
            rows.map((row) => row.id),
            rows.map((row) => row.lease),
            rows.map((row) => row.outcome),
            rows.map((row) => row.code),
            rows.map((row) => row.attempts),
          ],
        );
        return answer[0]?.n ?? 0;
      }),
    settle: () =>
      system(pool, async (client) => {
        const { rows } = await client.query<{ r: Record<string, unknown> }>(
          "SELECT push_settle() AS r",
        );
        return rows[0]?.r ?? {};
      }),
  };
}
