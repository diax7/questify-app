import type { Pool, PoolClient } from "pg";
import {
  abilityOff,
  deviceEventClosed,
  deviceUnpaired,
  invalidDevice,
  limitReached,
  notFound,
  notKiosk,
  notOperator,
  notScreenQr,
  outsideOperatorQuests,
  pairingBusy,
  unknownDevice,
  unknownPairingCode,
  wrongDeviceKind,
} from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import type { HttpError } from "#src/http-error";

type PgError = Readonly<{ code?: string; detail?: string }>;

const DV409: Readonly<Record<string, () => HttpError>> = {
  event_closed: () => deviceEventClosed(),
  limit_reached: () => limitReached(),
  not_screen_qr: () => notScreenQr(),
  not_kiosk: () => notKiosk(),
  wrong_kind: () => wrongDeviceKind(),
  code_taken: () => pairingBusy(),
};

/** The SQLSTATEs of migration 0057's doors as HTTP answers (API.md, Devices); undefined for anything else. */
export function deviceErrorOf(pg: PgError): HttpError | undefined {
  switch (pg.code) {
    case "DV401":
      return deviceUnpaired();
    case "DV404":
      return unknownPairingCode();
    case "DN404":
      return unknownDevice();
    case "DV409":
      return DV409[pg.detail ?? ""]?.();
    case "DV422":
      return invalidDevice({ field: pg.detail ?? "kind" });
    case "DV503":
      return pairingBusy();
    case "OP403":
      return notOperator();
    case "OA403":
      return abilityOff();
    case "OS403":
      return outsideOperatorQuests();
    case "OQ404":
    case "AN404":
      return notFound();
    default:
      return undefined;
  }
}

/** Runs one call in `context`; a refusal the database raises is thrown as its HTTP answer, anything else as it is. */
export async function inDevice<T>(
  pool: Pool,
  context: RequestContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, context, () => work(client)),
    );
  } catch (error) {
    throw deviceErrorOf(error as PgError) ?? error;
  }
}
