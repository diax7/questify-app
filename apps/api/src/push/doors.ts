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

/**
 * One fan-out call: the center rows written and whether more work may be waiting; a failed try also names the notice,
 * its SQLSTATE, when it is tried again (`retryAfter`) and `parked` at its third failure in a row (the alert).
 */
export type FanOutResult = Readonly<{
  rows: number;
  more: boolean;
  failed?: number;
  code?: string;
  retryAfter?: string;
  parked?: boolean;
}>;

/** One page of a group push to opted-in players (migration 0138): the players read and whether more may be waiting. */
export type GroupFanResult = Readonly<{ rows: number; more: boolean }>;

/** The push worker's six system doors; the unit tests replace them. */
export type PushDoors = Readonly<{
  /**
   * Writes the next page of the oldest running group push to opted-in players as one promotional notice each
   * (`group_push_fan`, T-706b); the fan-out below then turns the notices into center rows and sends.
   */
  groupFan: () => Promise<GroupFanResult>;
  fanOut: () => Promise<FanOutResult>;
  claim: (targets: readonly PushTarget[], size: number) => Promise<ClaimedSend[]>;
  ack: (rows: readonly AckRow[]) => Promise<number>;
  settle: () => Promise<Readonly<Record<string, unknown>>>;
  /**
   * The due scans (push_due, migrations 0077 and 0078): notices for moments in time, a count per scan and `more`.
   */
  due: () => Promise<Readonly<Record<string, unknown>>>;
}>;

const system = <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> =>
  withConnection(pool, (client) => withRequestContext(client, {}, () => work(client)));

/**
 * The doors on the worker's own pool, each in its own transaction in the system context (no player, staff, admin or
 * device), which the database checks again (PN403 `system_only`).
 */
export function createPushDoors(pool: Pool): PushDoors {
  return {
    groupFan: () =>
      system(pool, async (client) => {
        const { rows } = await client.query<{ r: GroupFanResult }>("SELECT group_push_fan() AS r");
        return rows[0]?.r ?? { rows: 0, more: false };
      }),
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
    due: () =>
      system(pool, async (client) => {
        const { rows } = await client.query<{ r: Record<string, unknown> }>(
          "SELECT push_due() AS r",
        );
        return rows[0]?.r ?? {};
      }),
  };
}
