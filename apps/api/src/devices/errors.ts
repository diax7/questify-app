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

const DV409: ReadonlyMap<string, () => HttpError> = new Map([
  ["event_closed", () => deviceEventClosed()],
  ["limit_reached", () => limitReached()],
  ["not_screen_qr", () => notScreenQr()],
  ["not_kiosk", () => notKiosk()],
  ["wrong_kind", () => wrongDeviceKind()],
  ["code_taken", () => pairingBusy()],
]);

type Answer = (pg: PgError) => HttpError | undefined;

const DEVICE_ERRORS: ReadonlyMap<string, Answer> = new Map<string, Answer>([
  ["DV401", () => deviceUnpaired()],
  ["DV404", () => unknownPairingCode()],
  ["DN404", () => unknownDevice()],
  ["DV409", (pg) => DV409.get(pg.detail ?? "")?.()],
  ["DV422", (pg) => invalidDevice({ field: pg.detail ?? "kind" })],
  ["DV503", () => pairingBusy()],
  ["OP403", () => notOperator()],
  ["OA403", () => abilityOff()],
  ["OS403", () => outsideOperatorQuests()],
  ["OQ404", () => notFound()],
  ["AN404", () => notFound()],
]);

/** The SQLSTATEs of migration 0057's doors as HTTP answers (API.md, Devices); undefined for anything else. */
export function deviceErrorOf(pg: PgError): HttpError | undefined {
  return pg.code === undefined ? undefined : DEVICE_ERRORS.get(pg.code)?.(pg);
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
