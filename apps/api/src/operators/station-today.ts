import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

export type StationTodayDeps = Readonly<{ pool: Pool }>;

/** My station today (FR-928): completions of the station's quest today and in the last hour, by everyone. */
export type StationToday =
  | Readonly<{ kind: "counts"; today: number; lastHour: number }>
  | Readonly<{ kind: "not_operator" }>
  | Readonly<{ kind: "not_station" }>
  | Readonly<{ kind: "outside_station" }>;

const REFUSALS: Readonly<Record<string, StationToday>> = {
  OP403: { kind: "not_operator" },
  OQ404: { kind: "not_station" },
  OS403: { kind: "outside_station" },
};

type Row = { today: string; last_hour: string };

/**
 * Reads the picked station's counts through `operator_station_today`: an operator of the event, a station quest of
 * that event, inside the operator's quest limit. Counts only; another code is thrown.
 */
export async function stationToday(
  deps: StationTodayDeps,
  operatorId: string,
  target: Readonly<{ eventId: string; questId: string }>,
): Promise<StationToday> {
  try {
    const row = await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: operatorId }, async () => {
        const { rows } = await client.query<Row>(
          "SELECT today, last_hour FROM operator_station_today($1, $2)",
          [target.eventId, target.questId],
        );
        return rows[0] as Row;
      }),
    );
    return { kind: "counts", today: Number(row.today), lastHour: Number(row.last_hour) };
  } catch (error) {
    const refusal = REFUSALS[(error as { code?: string }).code ?? ""];
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}
